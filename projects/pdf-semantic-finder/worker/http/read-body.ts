/**
 * Bounded request-body reading for the application API (spec §9.3).
 *
 * The Worker used to call `request.text()`, parse it, and *then* compare the size against
 * `maxRequestBodyBytes` — three full-size allocations before the limit applied, on a public
 * endpoint anyone can post to. The limit is enforced here instead, while the body is still
 * arriving, so an oversized upload is cancelled rather than measured.
 *
 * Pure of Workers runtime types on purpose, like `worker/search/validate.ts`: it takes the two
 * parts of a request it needs, so a unit test can hand it a plain object and a `ReadableStream`.
 * No error message or log line ever carries any of the rejected content (spec §10).
 */
import { LIMITS } from "@/lib/types";

/** Only the codes this module can produce; both already exist in `SearchErrorCode`. */
export type BoundedBodyFailure = "invalid_request" | "request_body_too_large";

export type BoundedBody = { ok: true; value: unknown; byteLength: number } | { ok: false; code: BoundedBodyFailure };

export type ReadBoundedJsonSource = {
    headers: Pick<Headers, "get">;
    body: ReadableStream<Uint8Array> | null;
};

export type ReadBoundedJsonOptions = {
    maxBytes?: number;
    /**
     * How long the body may take to arrive.
     *
     * A deadline checked inside the loop would not help: `read()` on a stalled connection may
     * simply never resolve, so the wait itself has to be abortable.
     */
    deadlineMs?: number;
    signal?: AbortSignal;
};

/**
 * True only for exactly `application/json`, with parameters allowed after `;`.
 *
 * The previous test was `header.includes("application/json")`, which also accepts
 * `text/plain; application/json`. That is not pedantry: `text/plain` is a CORS-safelisted request
 * content type, so a substring test lets any web page post here from a visitor's browser with no
 * preflight at all.
 */
export const isJsonMediaType = (header: string | null): boolean => (header ?? "").split(";")[0].trim().toLowerCase() === "application/json";

/**
 * Rejects on the declared length before a reader is acquired.
 *
 * An optimisation and nothing more — the header is client-supplied, so the real defence is counting
 * the bytes that actually arrive. A header that is absent, malformed or negative is ignored rather
 * than trusted in either direction.
 */
export const declaredLengthExceeds = (header: string | null, maxBytes: number): boolean => {
    if (header === null) return false;
    const declared = Number(header.trim());
    return Number.isInteger(declared) && declared >= 0 && declared > maxBytes;
};

export const readBoundedJson = async (source: ReadBoundedJsonSource, options: ReadBoundedJsonOptions = {}): Promise<BoundedBody> => {
    const maxBytes = options.maxBytes ?? LIMITS.maxRequestBodyBytes;
    const deadlineMs = options.deadlineMs ?? LIMITS.searchDeadlineMs;

    if (!isJsonMediaType(source.headers.get("Content-Type"))) return { ok: false, code: "invalid_request" };
    if (declaredLengthExceeds(source.headers.get("Content-Length"), maxBytes)) return { ok: false, code: "request_body_too_large" };
    if (source.body === null) return { ok: false, code: "invalid_request" };

    const timeout = AbortSignal.timeout(deadlineMs);
    const giveUp = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

    const reader = source.body.getReader();
    // `fatal` so invalid UTF-8 is a rejected request rather than silently replaced characters, and
    // `stream: true` per chunk so a multi-byte sequence split across a chunk boundary survives.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let byteLength = 0;
    let text = "";

    const abort = () => void reader.cancel().catch(() => undefined);
    giveUp.addEventListener("abort", abort, { once: true });

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            // Counted before the chunk is kept, so nothing oversized is ever retained.
            byteLength += value.byteLength;
            if (byteLength > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { ok: false, code: "request_body_too_large" };
            }

            text += decoder.decode(value, { stream: true });
        }

        text += decoder.decode();
    } catch {
        // A stalled body, a client that disappeared, or invalid UTF-8. None of them is reportable
        // in more detail without describing what was sent.
        return { ok: false, code: "invalid_request" };
    } finally {
        giveUp.removeEventListener("abort", abort);
        reader.releaseLock();
    }

    try {
        return { ok: true, value: JSON.parse(text), byteLength };
    } catch {
        return { ok: false, code: "invalid_request" };
    }
};
