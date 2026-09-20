/**
 * Calling TypeSafe AI Jev (spec §6.3, §6.4).
 *
 * `fetch` and the clock are injected, so every path here is testable without a network or a
 * Workers runtime. The limits enforced are this application's, not documented TypeSafe limits.
 */
import type { SearchErrorCode } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import type { JevRequestBody } from "./build-jev-request";
import { fromQuestionKey } from "./build-jev-request";
import type { JevScoreAnswer } from "./validate";
import { validateJevAnswer } from "./validate";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevUsage = { inputTokens: number; outputTokens: number };

export type BatchOutcome = { ok: true; answers: Map<string, JevScoreAnswer>; model: string; usage: JevUsage } | { ok: false; code: SearchErrorCode };

export type CallJevDependencies = {
    fetch: typeof globalThis.fetch;
    now: () => number;
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    apiKey: string;
    model: string;
    /** Absolute time by which the whole search must be finished (spec §6.4). */
    deadlineAt: number;
    signal?: AbortSignal;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Parses `Retry-After`, which may be either a delay in seconds or an HTTP date.
 * Returns null when the header is absent or unusable.
 */
export const parseRetryAfter = (header: string | null, now: number): number | null => {
    if (header === null) return null;

    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - now);
};

const parseAnswers = (
    payload: unknown,
    expectedSegmentIds: readonly string[],
): { ok: true; answers: Map<string, JevScoreAnswer>; model: string; usage: JevUsage } | { ok: false; code: SearchErrorCode } => {
    if (typeof payload !== "object" || payload === null) return { ok: false, code: "provider_malformed_response" };

    const body = payload as { model?: unknown; answers?: unknown; usage?: unknown };
    if (typeof body.model !== "string") return { ok: false, code: "provider_malformed_response" };
    if (typeof body.answers !== "object" || body.answers === null) return { ok: false, code: "provider_malformed_response" };

    const rawAnswers = body.answers as Record<string, unknown>;
    const answers = new Map<string, JevScoreAnswer>();

    for (const [questionKey, answer] of Object.entries(rawAnswers)) {
        const segmentId = fromQuestionKey(questionKey);
        if (segmentId === null) return { ok: false, code: "provider_malformed_response" };

        const validated = validateJevAnswer(answer);
        if (!validated.ok) return { ok: false, code: validated.error.code };

        answers.set(segmentId, validated.value);
    }

    // Spec §9.3: one valid answer for every requested segment. A missing or extra answer is a
    // malformed response, never a segment that happened to score zero.
    if (answers.size !== expectedSegmentIds.length) return { ok: false, code: "provider_malformed_response" };
    for (const segmentId of expectedSegmentIds) {
        if (!answers.has(segmentId)) return { ok: false, code: "provider_malformed_response" };
    }

    const usage = (body.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };

    return {
        ok: true,
        answers,
        model: body.model,
        usage: {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        },
    };
};

/**
 * Sends one batch, retrying once for a transient failure.
 *
 * The retry must fit inside the whole-search deadline: a per-request timeout would let a handful
 * of batches run far past it. A `Retry-After` longer than the remaining budget means failing now
 * rather than sleeping past the deadline.
 */
export const callJevBatch = async (request: JevRequestBody, dependencies: CallJevDependencies): Promise<BatchOutcome> => {
    const expectedSegmentIds = Object.keys(request.state.passages);
    let attempt = 0;

    for (;;) {
        const remaining = dependencies.deadlineAt - dependencies.now();
        if (remaining <= 0) return { ok: false, code: "provider_timeout" };

        const timeoutSignal = AbortSignal.timeout(remaining);
        const signal = dependencies.signal === undefined ? timeoutSignal : AbortSignal.any([dependencies.signal, timeoutSignal]);

        let response: Response;

        try {
            response = await dependencies.fetch(ENDPOINT, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${dependencies.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
                signal,
            });
        } catch (error) {
            // Transport-level failure. The name and message come from the runtime, never from the
            // request body, so logging them carries no document content (spec §10). Without this,
            // a provider failure is indistinguishable from a misconfigured call.
            console.error(
                JSON.stringify({
                    event: "jev_request_failed",
                    name: (error as Error | undefined)?.name ?? "Error",
                    message: (error as Error | undefined)?.message ?? "",
                }),
            );
            const isTimeout = (error as Error | undefined)?.name === "TimeoutError";
            if (attempt >= 1) return { ok: false, code: isTimeout ? "provider_timeout" : "provider_unavailable" };
            attempt += 1;
            continue;
        }

        if (response.ok) {
            let payload: unknown;
            try {
                payload = await response.json();
            } catch {
                return { ok: false, code: "provider_malformed_response" };
            }
            return parseAnswers(payload, expectedSegmentIds);
        }

        const isRetryable = RETRYABLE_STATUS.has(response.status);
        if (!isRetryable || attempt >= 1) return { ok: false, code: "provider_unavailable" };

        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"), dependencies.now());
        const backoff = retryAfter ?? 250;
        if (dependencies.now() + backoff >= dependencies.deadlineAt) return { ok: false, code: "provider_timeout" };

        await dependencies.sleep(backoff, dependencies.signal);
        attempt += 1;
    }
};

/**
 * Runs every batch with bounded concurrency and merges the answers.
 *
 * Spec §6.4: a partial batch failure fails the whole search. Returning what succeeded would report
 * an unevaluated document as though it had simply produced no match.
 */
export const callJevBatches = async (requests: readonly JevRequestBody[], dependencies: CallJevDependencies): Promise<BatchOutcome> => {
    const answers = new Map<string, JevScoreAnswer>();
    const usage: JevUsage = { inputTokens: 0, outputTokens: 0 };
    let model = dependencies.model;
    let failure: SearchErrorCode | null = null;
    let next = 0;

    const runWorker = async (): Promise<void> => {
        for (;;) {
            if (failure !== null) return;

            const index = next;
            next += 1;
            if (index >= requests.length) return;

            const outcome = await callJevBatch(requests[index], dependencies);

            if (!outcome.ok) {
                failure ??= outcome.code;
                return;
            }

            for (const [segmentId, answer] of outcome.answers) answers.set(segmentId, answer);
            usage.inputTokens += outcome.usage.inputTokens;
            usage.outputTokens += outcome.usage.outputTokens;
            model = outcome.model;
        }
    };

    const workerCount = Math.min(LIMITS.maxConcurrentRequests, requests.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));

    if (failure !== null) return { ok: false, code: failure };

    return { ok: true, answers, model, usage };
};
