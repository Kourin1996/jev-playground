/**
 * Application API Worker (spec §9).
 *
 * Validates the request, batches Jev calls, validates the responses, ranks, and classifies.
 * TypeSafe credentials never leave this Worker, and no log line carries a filename, a query, or
 * any extracted text (spec §10).
 */
import type { SearchErrorCode, SearchErrorResponse, SearchStreamMessage } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import { estimateSearchInputTokens } from "./admission/estimate-tokens";
import { readBoundedJson } from "./http/read-body";
import { isSameOriginRequest } from "./http/same-origin";
import { withSecurityHeaders } from "./http/security-headers";
import { buildJevRequest, packBatches } from "./search/build-jev-request";
import { callJevBatches } from "./search/call-jev";
import { rankResults } from "./search/rank-results";
import { validateSearchRequest } from "./search/validate";

// Re-exported because a Durable Object class has to be a named export of the entrypoint module.
export { SearchBudget } from "./admission/search-budget";

/**
 * Bindings come from `wrangler types` (`worker-env.d.ts`); secrets are declared here because they
 * are supplied by `.dev.vars` and by deployment secrets rather than by `wrangler.jsonc`.
 */
type WorkerEnv = Env & {
    TYPESAFE_API_KEY: string;
    TYPESAFE_MODEL?: string;
};

/**
 * Both admission bindings are optional.
 *
 * A unit test, a `wrangler dev` older than the binding, and a misconfigured deployment all reach
 * this code without them. Failing hard would make the tests depend on the platform; failing open
 * silently would leave a public endpoint unmetered — so it fails open and says so in the log, and
 * the deployment checklist in README.md is what catches it for real.
 */
const admission = (env: WorkerEnv) => ({
    rateLimit: (env as { SEARCH_RATE_LIMIT?: { limit: (options: { key: string }) => Promise<{ success: boolean }> } }).SEARCH_RATE_LIMIT,
    budget: (env as { SEARCH_BUDGET?: DurableObjectNamespace<import("./admission/search-budget").SearchBudget> }).SEARCH_BUDGET,
});

/**
 * Fixed, safe messages. They never describe which segment or which text was at fault, because
 * that would put document content into a response and, from there, into logs.
 */
const ERROR_MESSAGES: Record<SearchErrorCode, string> = {
    invalid_request: "The search request was not valid.",
    query_empty: "Enter a query before searching.",
    query_too_long: `A query may be at most ${LIMITS.maxQueryCharacters} characters.`,
    segments_empty: "The document has no searchable text.",
    too_many_segments: `This document exceeds the ${LIMITS.maxSegmentCount}-segment limit.`,
    duplicate_segment_id: "The search request was not valid.",
    malformed_segment_id: "The search request was not valid.",
    segment_text_empty: "The search request was not valid.",
    segment_text_too_long: `A segment may be at most ${LIMITS.maxSegmentCharacters} characters.`,
    extracted_text_too_long: `This document exceeds the ${LIMITS.maxExtractedCharacters.toLocaleString("en-US")}-character limit.`,
    request_body_too_large: "The search request was too large.",
    rate_limited: "Too many searches from this connection. Wait a few seconds and try again.",
    capacity_exhausted: "The search service is busy. Try again in a moment.",
    provider_unavailable: "The search could not be completed.",
    provider_timeout: "The search could not be completed.",
    provider_malformed_response: "The search could not be completed.",
    incomplete_evaluation: "The search could not be completed.",
    internal_error: "The search could not be completed.",
};

const STATUS_CODES: Partial<Record<SearchErrorCode, number>> = {
    request_body_too_large: 413,
    rate_limited: 429,
    capacity_exhausted: 503,
    provider_unavailable: 502,
    provider_timeout: 504,
    provider_malformed_response: 502,
    incomplete_evaluation: 502,
    internal_error: 500,
};

/**
 * Every `/api/` response carries these.
 *
 * `no-store` because none of this may be cached (spec §10), and `nosniff` because an error body is
 * JSON and must never be interpreted as anything else. Deliberately no `Access-Control-Allow-Origin`
 * anywhere: nothing cross-origin may read this endpoint.
 */
const apiHeaders = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
};

const errorResponse = (code: SearchErrorCode, extraHeaders: Record<string, string> = {}): Response => {
    const body: SearchErrorResponse = { error: { code, message: ERROR_MESSAGES[code] } };
    return Response.json(body, { status: STATUS_CODES[code] ?? 400, headers: { ...apiHeaders, ...extraHeaders } });
};

/** Newline-delimited JSON, so the reader is shown passages while the rest are still being judged. */
const streamHeaders = {
    ...apiHeaders,
    "Content-Type": "application/x-ndjson; charset=utf-8",
    // `no-transform` on top of `no-store`: a proxy that buffered the body would undo streaming.
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
};

/** The window declared in `wrangler.jsonc`, so `Retry-After` states the real interval. */
const RATE_LIMIT_PERIOD_SECONDS = 60;

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true },
        );
    });

const handleSearch = async (request: Request, env: WorkerEnv): Promise<Response> => {
    const startedAt = Date.now();
    const { rateLimit, budget } = admission(env);

    // Nothing below this comment has read the body: an unadmitted caller must not be able to make
    // this Worker buffer four megabytes, however many times they ask.
    if (!isSameOriginRequest(request.headers, request.url)) return errorResponse("invalid_request");

    /*
     * Keyed on the connecting client, and skipped when there is no such thing.
     *
     * Cloudflare sets `CF-Connecting-IP` at the edge and overwrites anything a client sent, so in
     * production it is always present and cannot be suppressed to escape the limit. It is absent in
     * local development — and bucketing every local caller under one constant key would mean an
     * unrelated process could exhaust the allowance and make this endpoint refuse a test run, which
     * is what it did before this comment existed.
     *
     * The provider budget below has no such dependency and still applies.
     */
    const client = request.headers.get("CF-Connecting-IP");
    if (rateLimit === undefined || client === null) {
        console.warn(JSON.stringify({ event: "admission_unavailable", gate: "rate_limit", reason: rateLimit === undefined ? "no_binding" : "no_client_ip" }));
    } else {
        const { success } = await rateLimit.limit({ key: client });
        if (!success) return errorResponse("rate_limited", { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) });
    }

    const body = await readBoundedJson(request, { signal: request.signal });
    if (!body.ok) return errorResponse(body.code);

    const validated = validateSearchRequest(body.value, body.byteLength);
    if (!validated.ok) return errorResponse(validated.error.code);

    const { documentId, requestId, query, segments } = validated.value;

    if (env.TYPESAFE_API_KEY === undefined || env.TYPESAFE_API_KEY === "") {
        console.error(JSON.stringify({ event: "search_failed", code: "internal_error", reason: "missing_credentials" }));
        return errorResponse("internal_error");
    }

    const model = env.TYPESAFE_MODEL ?? "jev-1.13.0";
    const packed = packBatches(segments);
    const batches = packed.map((batch) => buildJevRequest(model, query, batch));

    // Nothing below this has called the provider. The reservation is sized from the batches that
    // were actually packed, not from what the client claimed, and is released in `run`'s `finally`.
    const reservationId = crypto.randomUUID();
    if (budget === undefined) {
        console.warn(JSON.stringify({ event: "admission_unavailable", gate: "provider_budget" }));
    } else {
        const outcome = await budget.get(budget.idFromName("global")).reserve(reservationId, estimateSearchInputTokens(packed), packed.length);
        if (!outcome.ok) {
            console.warn(JSON.stringify({ event: "search_refused", code: "capacity_exhausted", batchCount: packed.length }));
            return errorResponse("capacity_exhausted", { "Retry-After": String(outcome.retryAfterSeconds) });
        }
    }

    const releaseBudget = () => {
        if (budget === undefined) return;
        void budget
            .get(budget.idFromName("global"))
            .release(reservationId)
            .catch(() => undefined);
    };

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let writable = true;

    /**
     * Writes one NDJSON line.
     *
     * Every line carries the document and request identifiers, error lines included: the client
     * validates what it receives against the search it asked for, and a line it cannot attribute
     * is a line it has to discard.
     */
    const emit = (message: SearchStreamMessage): void => {
        if (!writable) return;
        // A reader that navigated away closes the stream; that is ordinary, not an error, and the
        // search still has to finish tidily rather than throw out of the batch loop.
        writer.write(encoder.encode(`${JSON.stringify(message)}\n`)).catch(() => {
            writable = false;
        });
    };

    const run = async (): Promise<void> => {
        const outcome = await callJevBatches(batches, {
            // Bound deliberately: passing `globalThis.fetch` bare detaches it from its receiver
            // and the Workers runtime rejects the call with "Illegal invocation" before anything
            // is sent. A unit test cannot catch this, because an injected test double has no such
            // requirement.
            fetch: globalThis.fetch.bind(globalThis),
            now: Date.now,
            sleep,
            apiKey: env.TYPESAFE_API_KEY,
            model,
            // One deadline for the whole search, not one per request.
            deadlineAt: startedAt + LIMITS.searchDeadlineMs,
            signal: request.signal,
            onProgress: ({ evaluated, total, answers }) => {
                // Ranked over what is known so far. No status: §7 classifies over every segment.
                const provisional = rankResults(
                    segments.filter((segment) => answers.has(segment.id)),
                    answers,
                );
                emit({
                    type: "progress",
                    documentId,
                    requestId,
                    evaluated,
                    total,
                    results: provisional.ok ? provisional.results : [],
                });
            },
        });

        if (!outcome.ok) {
            console.error(
                JSON.stringify({
                    event: "search_failed",
                    code: outcome.code,
                    segmentCount: segments.length,
                    batchCount: batches.length,
                    model,
                    elapsedMs: Date.now() - startedAt,
                }),
            );
            emit({ type: "error", documentId, requestId, error: { code: outcome.code, message: ERROR_MESSAGES[outcome.code] } });
            return;
        }

        const ranked = rankResults(segments, outcome.answers);
        if (!ranked.ok) {
            console.error(JSON.stringify({ event: "search_failed", code: ranked.code, model }));
            emit({ type: "error", documentId, requestId, error: { code: ranked.code, message: ERROR_MESSAGES[ranked.code] } });
            return;
        }

        const elapsedMs = Date.now() - startedAt;

        console.log(
            JSON.stringify({
                event: "search_completed",
                status: ranked.status,
                segmentCount: segments.length,
                batchCount: batches.length,
                resultCount: ranked.results.length,
                model: outcome.model,
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
                elapsedMs,
            }),
        );

        emit({
            type: "final",
            documentId,
            requestId,
            status: ranked.status,
            results: ranked.results,
            evaluations: ranked.evaluations,
            evaluatedSegmentCount: ranked.evaluatedSegmentCount,
            requestCount: batches.length,
            model: outcome.model,
            elapsedMs,
        });
    };

    /*
     * The stream is returned immediately and filled as the batches land. An error after the
     * headers have gone cannot become a status code, so it travels as a final `error` line and the
     * client treats it exactly as it treats a non-2xx body — a failed search, never a no-match.
     */
    void run()
        .catch((error: unknown) => {
            console.error(JSON.stringify({ event: "search_failed", code: "internal_error", name: (error as Error | undefined)?.name ?? "Error" }));
            emit({ type: "error", documentId, requestId, error: { code: "internal_error", message: ERROR_MESSAGES.internal_error } });
        })
        .finally(() => {
            // Returned on every path, including a reader that disconnected mid-stream. The
            // reservation also expires on its own, so a lost release costs one deadline, not the
            // budget.
            releaseBudget();
            void writer.close().catch(() => undefined);
        });

    return new Response(stream.readable, { headers: streamHeaders });
};

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/api/search") {
            if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: apiHeaders });

            try {
                return await handleSearch(request, env);
            } catch (error) {
                // Never interpolate request content into an error: it would reach the logs.
                console.error(
                    JSON.stringify({
                        event: "search_failed",
                        code: "internal_error",
                        name: (error as Error | undefined)?.name ?? "Error",
                    }),
                );
                return errorResponse("internal_error");
            }
        }

        if (url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404, headers: apiHeaders });

        return withSecurityHeaders(await env.ASSETS.fetch(request));
    },
} satisfies ExportedHandler<WorkerEnv>;
