/**
 * Client for the meaning-search endpoint (spec §9).
 *
 * Not named in spec §12's tree; added so the abort and staleness handling of §9.3 lives outside
 * the components. It owns no state — the caller supplies the identifiers and the signal.
 */
import type { PdfSegment, SearchErrorCode, SearchRequest, SearchResponse, SearchResultRecord, SearchStreamMessage } from "@/lib/types";
import { isSearchErrorResponse } from "@/lib/types";

export type SemanticSearchOutcome = { ok: true; response: SearchResponse } | { ok: false; code: SearchErrorCode };

/**
 * Builds the request body.
 *
 * Only the query and the segment text leave the browser. The PDF bytes, the filename, and any
 * browser display reference stay here (spec §9.2) — though a segment ID encodes its page number,
 * so the page ordinal does travel.
 *
 * The neighbouring passages travel with each segment. A clause split by a page break leaves the
 * target alone saying something incomplete, and references such as 前項 mean nothing in isolation.
 */
export const buildSearchRequest = (documentId: string, requestId: string, query: string, segments: readonly PdfSegment[]): SearchRequest => ({
    documentId,
    requestId,
    query,
    // Segments are sent in document order. The Worker has no page numbers and relies on this
    // order for spec §7's tie-break, so it is part of the contract.
    segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.originalText,
        ...(segment.contextBefore === undefined ? {} : { contextBefore: segment.contextBefore }),
        ...(segment.contextAfter === undefined ? {} : { contextAfter: segment.contextAfter }),
    })),
});

/** Reported as each batch lands, so the reader sees passages before the last one is judged. */
export type SemanticSearchProgress = {
    evaluated: number;
    total: number;
    results: SearchResultRecord[];
};

/**
 * Runs a meaning search, reporting partial results as they arrive.
 *
 * The response is newline-delimited JSON rather than one object: at the segment cap the search is
 * 500 round-trips deep and takes about five seconds, while the first answers come back in under
 * half a second. `onProgress` carries those; the returned outcome is the authoritative one.
 *
 * An error can arrive after the headers, so a failure is not always a status code. Both forms end
 * as `{ ok: false }` — a failed search is never a no-match (spec §9.2).
 */
export const requestSemanticSearch = async (
    request: SearchRequest,
    signal: AbortSignal,
    onProgress?: (progress: SemanticSearchProgress) => void,
): Promise<SemanticSearchOutcome> => {
    const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
    });

    if (!response.ok) {
        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            return { ok: false, code: "provider_malformed_response" };
        }
        return { ok: false, code: isSearchErrorResponse(payload) ? payload.error.code : "internal_error" };
    }

    if (response.body === null) return { ok: false, code: "provider_malformed_response" };

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    let final: SemanticSearchOutcome | null = null;

    const consume = (line: string): void => {
        if (line.trim() === "") return;

        let message: SearchStreamMessage;
        try {
            message = JSON.parse(line) as SearchStreamMessage;
        } catch {
            final ??= { ok: false, code: "provider_malformed_response" };
            return;
        }

        if (message.type === "progress") onProgress?.(message);
        else if (message.type === "error") final ??= { ok: false, code: message.error.code };
        else {
            const { type, ...response } = message;
            void type;
            final ??= { ok: true, response };
        }
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered += value;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
            consume(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
        }
    }
    consume(buffered);

    // A stream that ended without a final line is a search that did not finish, not one that found
    // nothing.
    return final ?? { ok: false, code: "provider_malformed_response" };
};
