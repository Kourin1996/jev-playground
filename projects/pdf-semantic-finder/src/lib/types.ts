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
    /**
     * Derived from the measured median unit size, not from an assumed one.
     *
     * `maxExtractedCharacters / typicalSegmentCharacters` is `50,000 / 100 = 500`. See
     * `typicalSegmentCharacters` for where 125 comes from. A document that stays inside the
     * character cap but divides far more finely than that is rejected with its segment count
     * named, the way every other declared limit behaves — it is never re-merged to fit.
     */
    maxSegmentCount: 500,
    maxSegmentCharacters: 800,
    maxQueryCharacters: 200,
    /**
     * Derived from the character cap, not chosen: a document inside every client-side limit must
     * never be rejected here, or the reader sees a search error where a limit message belongs.
     *
     * Each segment's text travels three times — as itself, and as each neighbour's context — so
     * the worst case is `3 × maxExtractedCharacters` characters. At 4 UTF-8 bytes each (a
     * surrogate pair such as 𠮟 counts as one character and four bytes) that is 600,000, plus
     * about 80 bytes of JSON per segment at `maxSegmentCount`, which is 640,000.
     *
     * This was 256 KiB, which a full-size Japanese document exceeded on context duplication
     * alone: the Worker answered `request_body_too_large` for a document the client had already
     * accepted. No test caught it because no fixture is anywhere near the character cap.
     */
    maxRequestBodyBytes: 1024 * 1024,
    /**
     * Length below which a group is *considered* for merging into a neighbour.
     *
     * A secondary condition, never the deciding one. What decides is sentence-ending punctuation:
     * a heading, a bare clause number, a figure label and a line of a formula carry none, while a
     * clause that answers something ends in `。` however short it is. See `opensNextPassage` and
     * `closesPreviousPassage` in `build-segments.ts`.
     *
     * Using length alone — first at 250, then at 40 — put five independent clauses into one search
     * unit on a document of short 条, which is the very failure removing the 250-character floor
     * was meant to end. 40 only bounds how much text a heading or a paragraph tail may carry
     * before it counts as a passage in its own right.
     */
    minSegmentCharacters: 40,
    /** A paragraph that reaches this length with no boundary in sight is cut anyway. */
    softMaxSegmentCharacters: 450,
    /**
     * Median characters per search unit, measured rather than assumed.
     *
     * 97 on `assets/bitcoin.pdf` (112 units over 21,129 characters) and 113 on the generated
     * Japanese contract (13 units over 1,469). 100 sits between them. Only `maxSegmentCount` is
     * derived from it; segmentation itself never consults it.
     */
    typicalSegmentCharacters: 100,
    /**
     * Passages in one request's state.
     *
     * Measured rather than chosen: growing the state from 1 passage to 8 halved the score of a
     * passage Jev was unsure about (P(level 2) ≈ 0.50 → ≈ 0.25 on `assets/bitcoin.pdf`, ≈ 0.44 →
     * ≈ 0.24 on the Japanese sample), while asking 8 questions instead of 1 over the same state
     * changed nothing measurable. At 4 the movement was within or near the run-to-run spread of
     * about 0.03 on the English sample. See docs/spec.md §14.19.
     */
    maxSegmentsPerBatch: 4,
    /**
     * Derived, so the character limit can never force a smaller batch than the count limit.
     *
     * `maxSegmentsPerBatch × maxSegmentCharacters × 3` — text plus two neighbours of context — is
     * `4 × 800 × 3 = 9,600`. Every state therefore comes out the same size, which is the whole
     * point of the packing. The previous 6,000 was below `8 × 800`, so the two limits were not
     * simultaneously satisfiable and characters had to win (the old §14.4).
     */
    maxCharactersPerBatch: 10_000,
    /**
     * In-flight requests.
     *
     * Raised with the batch size cut: at the segment cap this is `ceil(500 / 4) = 125` requests,
     * so 16 rounds, leaving about 940 ms per round-trip inside `searchDeadlineMs`. A real search
     * of 112 segments measured about 450 ms per round-trip, so that is roughly twofold headroom —
     * but no document near the cap has been timed, and more concurrency means more chance of a
     * rate-limited response spending its one retry.
     */
    maxConcurrentRequests: 8,
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
    /**
     * Offset inside the *item* where this piece begins.
     *
     * Zero everywhere except in a part produced by `splitLongLine`, which is the only place a
     * piece is cut. Without it a segment built from a cut piece can only name the item, so every
     * part of a split item claims the whole of it.
     */
    itemOffset: number;
    /** Full length of the item in code points, so a piece can tell whether it covers all of it. */
    itemLength: number;
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
    /**
     * Exactly the characters this segment covers, for highlighting.
     *
     * `itemIndexes` names whole items, which is wrong whenever one item is split across several
     * segments: each would claim all of it, and selecting any one would light up all of them. A
     * range still covers the whole passage — it is the passage, not a narrowed phrase.
     */
    ranges: TextRange[];
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
/**
 * A run of characters inside one text item.
 *
 * Exact search narrows to the matched characters, so two occurrences inside one item highlight
 * differently. Meaning search spans whole items, which is what `wholeItem` expresses.
 */
export type TextRange = {
    itemIndex: number;
    /** Inclusive start offset into the item's `str`, or 0 when the whole item is covered. */
    startOffset: number;
    /** Exclusive end offset, or the item's length when the whole item is covered. */
    endOffset: number;
    /** True when the range is the entire item and offsets need not be consulted. */
    wholeItem: boolean;
};

/** Covers an item completely, which is how meaning results address their evidence. */
export const wholeItemRange = (itemIndex: number): TextRange => ({
    itemIndex,
    startOffset: 0,
    endOffset: 0,
    wholeItem: true,
});

export type SearchHit = {
    /** Stable across a result set, for list keys and selection. */
    key: string;
    pageNumber: number;
    /** Exactly what to highlight, in reading order. */
    ranges: TextRange[];
    /** What the results list shows. */
    previewText: string;
    /** Present only for meaning results, which are whole segments. */
    segmentId?: string;
    /**
     * The neighbouring passages that travelled with this one, and which segment each of them is.
     *
     * Only for meaning results. A clause whose limit lives next door — `前項の期限を守った場合に限り`
     * — cannot be read from the target alone, and §6.3 now permits the model to use the neighbours
     * for exactly that. A reader who cannot reach them is worse off than the model was.
     *
     * The provider does not report which context it used, so this is what was **sent**, never what
     * was relied on. The wording in the panel says so.
     */
    contextBefore?: SearchHitContext;
    contextAfter?: SearchHitContext;
};

export type SearchHitContext = {
    /** The neighbouring segment, so the reader can be taken to it in the document. */
    segmentId: string;
    text: string;
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
    /**
     * Every evaluated segment in document order, not only the ranked few.
     *
     * `results` says what was chosen; this says what each passage was judged to be, including the
     * passages that were rejected — which is the only way to see whether a passage was missed
     * because Jev scored it low or because it was never a search unit in the first place. It feeds
     * the extracted-text debug view and nothing else.
     *
     * Optional because it is diagnostic: a response without it is still a valid search result.
     */
    evaluations?: SearchResultRecord[];
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
