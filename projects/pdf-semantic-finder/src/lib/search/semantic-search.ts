/**
 * Client for the meaning-search endpoint (spec §9).
 *
 * Not named in spec §12's tree; added so the abort and staleness handling of §9.3 lives outside
 * the components. It owns no state — the caller supplies the identifiers and the signal.
 */
import type { PdfSegment, SearchErrorCode, SearchRequest, SearchResponse } from "@/lib/types";
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

export const requestSemanticSearch = async (request: SearchRequest, signal: AbortSignal): Promise<SemanticSearchOutcome> => {
    const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
    });

    let payload: unknown;

    try {
        payload = await response.json();
    } catch {
        return { ok: false, code: "provider_malformed_response" };
    }

    if (!response.ok) {
        // A failed search is an error, never a report of no match (spec §9.2).
        return { ok: false, code: isSearchErrorResponse(payload) ? payload.error.code : "internal_error" };
    }

    return { ok: true, response: payload as SearchResponse };
};
