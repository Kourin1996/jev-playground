/**
 * Shared contract between the browser client and the application API Worker.
 *
 * Canonical definitions live in `docs/spec.md`; section references below point at it.
 */

/** Declared PoC limits (spec §2 and §9.3). Enforced before search, never by truncating. */
export const LIMITS = {
    maxFileBytes: 10 * 1024 * 1024,
    maxPageCount: 10,
    maxExtractedCharacters: 50_000,
    maxSegmentCount: 200,
    maxSegmentCharacters: 800,
    maxQueryCharacters: 200,
    maxRequestBodyBytes: 256 * 1024,
    /**
     * Segmentation packs to at least this many characters before honoring a boundary.
     *
     * Derived, not chosen: `maxExtractedCharacters / maxSegmentCount` is 250, so a document that
     * fits the character budget also fits the segment budget. Without the floor, one segment per 項
     * would trip the segment cap on an ordinary contract. `limits are consistent` in
     * tests/search-client.test.ts pins the relationship. See the §5.2 deviation in docs/spec.md.
     */
    minSegmentCharacters: 250,
    softMaxSegmentCharacters: 450,
    maxSegmentsPerBatch: 8,
    maxCharactersPerBatch: 6_000,
    maxConcurrentRequests: 3,
    searchDeadlineMs: 15_000,
    maxResults: 3,
} as const;

/** Relevance thresholds on P(level 2) (spec §7). Hypotheses to calibrate, not measured values. */
export const THRESHOLDS = {
    matched: 0.65,
    uncertain: 0.35,
} as const;

/**
 * Counts characters the way every limit in this repository means them.
 *
 * `String.prototype.length` counts UTF-16 code units, so a surrogate pair such as 𠮟 would count
 * as two. The client and the Worker must agree, or the Worker rejects a document the client
 * accepted and the reader sees a search error instead of a limit message.
 */
export const countCharacters = (text: string): number => [...text].length;

/** Segment IDs are interpolated into Jev instructions, so the grammar is enforced, not assumed. */
export const SEGMENT_ID_PATTERN = /^p\d{3}-s\d{3}$/u;

/**
 * Tolerance for the "probabilities sum to 1" check (spec §9.3).
 *
 * Derived from how the provider serializes them, not guessed: it rounds each probability to two
 * decimal places, so each is within 0.005 of its true value and three of them are within 0.015.
 * An observed real response was `{0: 0.05, 1: 0.93, 2: 0.01}`, summing to 0.99.
 *
 * This was 1e-3 on the assumption of four-decimal rounding, which rejected that response and
 * failed the whole search. Anything tighter than 0.015 turns ordinary rounding into a
 * user-visible error; 0.02 leaves margin while still catching a genuinely broken distribution.
 */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

/**
 * The shape of a PDF.js text item that segmentation depends on.
 *
 * Declared structurally so `build-segments.ts` stays free of any PDF.js import and can be
 * exercised with plain objects.
 */
export type TextItemLike = {
    str: string;
    /** `[a, b, c, d, e, f]`; `e` is x and `f` is the baseline y, in PDF user space. */
    transform: number[];
    width: number;
    height: number;
    hasEOL: boolean;
};

/**
 * The span of `ExtractedLine.text` that one original text item produced.
 *
 * Offsets are code-point indexes, matching `countCharacters`. Keeping them is what lets an
 * overlong line be split into segments that each map to the items they actually contain, instead
 * of every part claiming the whole line.
 */
export type LinePiece = {
    /** Index into `TextContent.items`. */
    itemIndex: number;
    /** Inclusive start offset in the line's text. */
    start: number;
    /** Exclusive end offset in the line's text. */
    end: number;
};

/** One reconstructed line of text, with the original item indexes it was built from. */
export type ExtractedLine = {
    text: string;
    /** Where each original item landed in `text`, in reading order. */
    pieces: LinePiece[];
    /**
     * Original indexes into `TextContent.items`, ascending.
     *
     * This is the set of items the line covers, not a parallel array: display order and numeric
     * index order diverge whenever items are reordered for reading order.
     */
    itemIndexes: number[];
    /** Leftmost x in PDF user space. */
    x: number;
    /** Baseline y in PDF user space. Larger values are higher on the page. */
    y: number;
    /** Representative glyph height, used for gap and heading heuristics. */
    fontSize: number;
};

/** A searchable passage, mapped back to its physical page and PDF.js text items (spec §5.3). */
export type PdfSegment = {
    /** Example: "p003-s004". */
    id: string;
    /** One-based physical page number. */
    pageNumber: number;
    /** Extracted text shown to the reader. AI must not rewrite it. */
    originalText: string;
    /** Deterministically normalized for search. */
    searchText: string;
    /**
     * Original PDF.js text-item indexes covered by this segment, ascending.
     *
     * Used to recover the location. Never re-derived by searching the rendered text for a
     * matching string, which would resolve repeated passages to the wrong occurrence.
     */
    itemIndexes: number[];
    contextBefore?: string;
    contextAfter?: string;
};

export type SearchMode = "exact" | "meaning";

/**
 * One thing the reader can be taken to, from either search mode.
 *
 * Meaning search returns segments; exact search returns occurrences, which can straddle segment
 * boundaries and so are not segments at all. Both reduce to a page, the items to highlight, and
 * some text to show, which is all the viewer and the results list ever needed.
 */
export type SearchHit = {
    /** Stable across a result set, for list keys and selection. */
    key: string;
    pageNumber: number;
    /** Original PDF.js text-item indexes to highlight, ascending. */
    itemIndexes: number[];
    /** What the results list shows. */
    previewText: string;
    /** Present only for meaning results, which are whole segments. */
    segmentId?: string;
};

export type SearchStatus = "matched" | "uncertain" | "no_match";

export type SearchRequest = {
    /** New for each loaded PDF. */
    documentId: string;
    /** New for each search. */
    requestId: string;
    query: string;
    segments: Array<{
        id: string;
        text: string;
        contextBefore?: string;
        contextAfter?: string;
    }>;
};

export type SearchResultRecord = {
    segmentId: string;
    score: number;
    relevantProbability: number;
    confidence: number;
};

export type SearchResponse = {
    documentId: string;
    requestId: string;
    status: SearchStatus;
    results: SearchResultRecord[];
    evaluatedSegmentCount: number;
    model: string;
    elapsedMs: number;
};

/**
 * Stable application error codes (spec §9.2). Failed searches carry one of these with a safe
 * fixed message and a non-2xx status; they must never be reported as `no_match`.
 */
export type SearchErrorCode =
    | "invalid_request"
    | "query_empty"
    | "query_too_long"
    | "segments_empty"
    | "too_many_segments"
    | "duplicate_segment_id"
    | "malformed_segment_id"
    | "segment_text_empty"
    | "segment_text_too_long"
    | "extracted_text_too_long"
    | "request_body_too_large"
    | "provider_unavailable"
    | "provider_timeout"
    | "provider_malformed_response"
    | "incomplete_evaluation"
    | "internal_error";

export type SearchErrorResponse = {
    error: {
        code: SearchErrorCode;
        message: string;
    };
};

export const isSearchErrorResponse = (value: unknown): value is SearchErrorResponse => typeof value === "object" && value !== null && "error" in value;
