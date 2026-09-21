/**
 * Application API Worker (spec §9).
 *
 * Validates the request, batches Jev calls, validates the responses, ranks, and classifies.
 * TypeSafe credentials never leave this Worker, and no log line carries a filename, a query, or
 * any extracted text (spec §10).
 */
import type { SearchErrorCode, SearchErrorResponse, SearchStreamMessage } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import { buildJevRequest, packBatches } from "./search/build-jev-request";
import { callJevBatches } from "./search/call-jev";
import { rankResults } from "./search/rank-results";
import { validateSearchRequest } from "./search/validate";

/**
 * Bindings come from `wrangler types` (`worker-env.d.ts`); secrets are declared here because they
 * are supplied by `.dev.vars` and by deployment secrets rather than by `wrangler.jsonc`.
 */
type WorkerEnv = Env & {
    TYPESAFE_API_KEY: string;
    TYPESAFE_MODEL?: string;
};

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
    provider_unavailable: "The search could not be completed.",
    provider_timeout: "The search could not be completed.",
    provider_malformed_response: "The search could not be completed.",
    incomplete_evaluation: "The search could not be completed.",
    internal_error: "The search could not be completed.",
};

const STATUS_CODES: Partial<Record<SearchErrorCode, number>> = {
    provider_unavailable: 502,
    provider_timeout: 504,
    provider_malformed_response: 502,
    incomplete_evaluation: 502,
    internal_error: 500,
};

const errorResponse = (code: SearchErrorCode): Response => {
    const body: SearchErrorResponse = { error: { code, message: ERROR_MESSAGES[code] } };
    return Response.json(body, { status: STATUS_CODES[code] ?? 400 });
};

/**
 * Newline-delimited JSON, so the reader is shown passages while the rest are still being judged.
 *
 * `no-transform` because a proxy that buffered the body would undo the entire point, and
 * `no-store` because none of this may be cached (spec §10).
 */
const streamHeaders = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
};

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

    if (!request.headers.get("Content-Type")?.includes("application/json")) {
        return errorResponse("invalid_request");
    }

    const rawBody = await request.text();
    let parsed: unknown;

    try {
        parsed = JSON.parse(rawBody);
    } catch {
        return errorResponse("invalid_request");
    }

    const validated = validateSearchRequest(parsed, new TextEncoder().encode(rawBody).byteLength);
    if (!validated.ok) return errorResponse(validated.error.code);

    const { documentId, requestId, query, segments } = validated.value;

    if (env.TYPESAFE_API_KEY === undefined || env.TYPESAFE_API_KEY === "") {
        console.error(JSON.stringify({ event: "search_failed", code: "internal_error", reason: "missing_credentials" }));
        return errorResponse("internal_error");
    }

    const model = env.TYPESAFE_MODEL ?? "jev-1.13.0";
    const batches = packBatches(segments).map((batch) => buildJevRequest(model, query, batch));

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let writable = true;

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
            emit({ type: "error", error: { code: outcome.code, message: ERROR_MESSAGES[outcome.code] } });
            return;
        }

        const ranked = rankResults(segments, outcome.answers);
        if (!ranked.ok) {
            console.error(JSON.stringify({ event: "search_failed", code: ranked.code, model }));
            emit({ type: "error", error: { code: ranked.code, message: ERROR_MESSAGES[ranked.code] } });
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
            emit({ type: "error", error: { code: "internal_error", message: ERROR_MESSAGES.internal_error } });
        })
        .finally(() => void writer.close().catch(() => undefined));

    return new Response(stream.readable, { headers: streamHeaders });
};

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/api/search") {
            if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

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

        if (url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404 });

        return env.ASSETS.fetch(request);
    },
} satisfies ExportedHandler<WorkerEnv>;
