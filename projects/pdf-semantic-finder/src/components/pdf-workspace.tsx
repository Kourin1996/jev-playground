/**
 * Owns document and search state (spec §3, §9.3, §10).
 *
 * The staleness guard is the load-bearing part: identifiers are compared against refs holding the
 * current values, never against values captured when the search started. Comparing against a
 * captured identifier would always agree with itself, so results from a discarded PDF would render
 * against the new one — a silent wrong-passage failure rather than an error.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ExtractedTextView } from "@/components/extracted-text-view";
import { PdfViewer } from "@/components/pdf-viewer";
import { SearchBar } from "@/components/search-bar";
import { SearchResults } from "@/components/search-results";
import { buildSegments } from "@/lib/pdf/build-segments";
import type { LimitViolation } from "@/lib/pdf/check-limits";
import { checkFileLimits, checkSegmentLimits, describeLimitViolation } from "@/lib/pdf/check-limits";
import type { PdfExtraction } from "@/lib/pdf/extract-text";
import { PageCountExceededError, extractPdfText } from "@/lib/pdf/extract-text";
import type { HighlightTargetFailure } from "@/lib/pdf/highlight";
import { buildPageIndexes } from "@/lib/pdf/page-index";
import type { PageIndex } from "@/lib/pdf/page-index";
import { exactSearch } from "@/lib/search/exact-search";
import { buildSearchRequest, requestSemanticSearch } from "@/lib/search/semantic-search";
import type { PdfSegment } from "@/lib/types";
import type { SearchErrorCode, SearchHit, SearchMode, SearchResultRecord, SearchStatus } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import { cx } from "@/utils/cx";

/** Zoom is stored to two decimals so the label and the rendered scale cannot disagree. */
const round = (value: number) => Number(value.toFixed(2));

/**
 * The zoom levels the buttons step through.
 *
 * A ladder rather than ±0.25 from wherever fit-to-width landed: fitting a page gives an arbitrary
 * scale such as 1.38, and stepping from it would never reach 100% again. §11.2 asks for the
 * highlight to be checked at 100%, 125% and 150%, which has to be something a reader can actually
 * select.
 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const zoomOut = (scale: number) => [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001) ?? ZOOM_STEPS[0];
const zoomIn = (scale: number) => ZOOM_STEPS.find((step) => step > scale + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * Below this width the two panes do not fit side by side and are shown one at a time.
 *
 * Measured rather than chosen: at 390 px the results pane kept its 336 px and its 280 px floor, the
 * divider took 6 px, and the PDF was left with about 18 px. Dragging a divider is not a workable
 * answer on a phone either.
 */
const SINGLE_PANE_WIDTH = 768;

/** Bounds for the results panel: narrow enough to read a passage, wide enough to leave the page usable. */
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const clampPanelWidth = (width: number) => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));

type LoadedDocument = {
    documentId: string;
    fileName: string;
    extraction: PdfExtraction;
    segments: PdfSegment[];
    /** Per-page searchable text, so exact search does not depend on how the page was segmented. */
    pageIndexes: PageIndex[];
    limitViolations: LimitViolation[];
    /**
     * Spec §11.3 requires extraction to be recorded separately from semantic search, so the two
     * cannot be confused when the five-second target is assessed. Duration only; no content.
     */
    extractionMs: number;
};

const ERROR_TEXT: Partial<Record<SearchErrorCode, string>> = {
    provider_unavailable: "The evaluation service did not respond successfully.",
    provider_timeout: "The evaluation service did not respond in time.",
    provider_malformed_response: "The evaluation service returned an unusable response.",
    incomplete_evaluation: "Some passages were not evaluated.",
};

const LOAD_ERROR_TEXT: Record<string, string> = {
    PasswordException: "This PDF is password protected. Remove the password and try again.",
    InvalidPDFException: "This file could not be read as a PDF.",
};

export const PdfWorkspace = () => {
    const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const [query, setQuery] = useState("");
    const [mode, setMode] = useState<SearchMode>("meaning");
    const [isSearching, setIsSearching] = useState(false);
    const [status, setStatus] = useState<SearchStatus | null>(null);
    const [results, setResults] = useState<SearchHit[]>([]);
    /**
     * The **key** of the result being shown in the viewer, or null.
     *
     * Not an index. While a meaning search streams, the list is re-ranked with every batch, so
     * position *n* can become a different passage between two frames — the viewer would follow
     * along and highlight somewhere else without anything having been selected. A key follows the
     * passage.
     *
     * Any search that produced candidates opens its highest ranked one, uncertain included: the
     * reader asked to be taken to the passage, and the uncertain note above the list already says
     * how much weight to give it.
     */
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    /**
     * The query and mode that produced `results`, which are not always the ones in the search bar.
     *
     * Editing the query or switching mode does not clear the results — there is nothing wrong with
     * still seeing what you last searched for. What is wrong is describing those results with the
     * text now in the box: the panel emphasises query terms and words an empty result differently
     * per mode, so a stale list was being annotated against a search nobody had run.
     */
    const [submitted, setSubmitted] = useState<{ query: string; mode: SearchMode } | null>(null);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [searchMs, setSearchMs] = useState<number | null>(null);
    /**
     * How far a meaning search has got, or null when none is running.
     *
     * The results shown while this is set are whatever currently scores highest, and they change
     * as more passages are judged. The panel says so: §7 classifies over every segment, so no
     * status is claimed until the search finishes.
     */
    const [progress, setProgress] = useState<{ evaluated: number; total: number } | null>(null);
    /**
     * What the last meaning search cost, in the two units that actually bill.
     *
     * Spec §14.20 measures per request, not per question, so both numbers have to be visible: a
     * document twice the size is twice the questions but not necessarily twice the requests.
     */
    const [lastSearchCost, setLastSearchCost] = useState<{ questions: number; requests: number } | null>(null);
    /**
     * Every segment's judgement from the last meaning search, for the extracted-text view.
     *
     * Cleared with the rest of the search state, so it can never describe a document or a query
     * that is no longer on screen.
     */
    const [evaluations, setEvaluations] = useState<Map<string, SearchResultRecord> | null>(null);
    const [highlightFailure, setHighlightFailure] = useState<HighlightTargetFailure | null>(null);

    const [scale, setScale] = useState<number | null>(null);
    const [showExtractedText, setShowExtractedText] = useState(false);
    const [visiblePage, setVisiblePage] = useState(1);
    /** Width of the results panel, dragged by the divider between the two. */
    const [panelWidth, setPanelWidth] = useState(336);
    /** True while the viewport is too narrow to show both panes at once. */
    const [isNarrow, setIsNarrow] = useState(false);
    /** Which pane a narrow screen is showing. Ignored when both fit. */
    const [narrowPane, setNarrowPane] = useState<"results" | "document">("document");
    const viewerRef = useRef<HTMLDivElement>(null);
    const [fitScale, setFitScale] = useState(1);

    // Refs hold the authoritative current identifiers. They are updated synchronously, so a guard
    // reads the newest value even before React commits.
    const currentDocumentIdRef = useRef<string>("");
    const currentRequestIdRef = useRef<string>("");
    const abortRef = useRef<AbortController | null>(null);
    /** Separate from the search controller: opening a document and searching it are cancelled apart. */
    const loadAbortRef = useRef<AbortController | null>(null);

    const resetSearchState = useCallback(() => {
        setIsSearching(false);
        setSearchMs(null);
        setStatus(null);
        setResults([]);
        setSelectedKey(null);
        hasChosenResultRef.current = false;
        setSubmitted(null);
        setSearchError(null);
        setHighlightFailure(null);
        setEvaluations(null);
        setProgress(null);
        setLastSearchCost(null);
    }, []);

    const openDocument = useCallback(
        async (file: File) => {
            // Claimed before the first await, so a second file chosen while this one is loading
            // supersedes it from the very beginning rather than from wherever the first suspension
            // point happens to be.
            const documentId = crypto.randomUUID();
            currentDocumentIdRef.current = documentId;

            loadAbortRef.current?.abort();
            const loadController = new AbortController();
            loadAbortRef.current = loadController;

            abortRef.current?.abort();
            abortRef.current = null;
            currentRequestIdRef.current = "";

            setNarrowPane("document");
            // A new document is opened to be read, not to have its extraction inspected — and the
            // view that was open belonged to the document being replaced.
            setShowExtractedText(false);

            const previous = loaded;
            setLoaded(null);
            setLoadError(null);
            resetSearchState();
            setIsLoading(true);

            if (previous !== null) await previous.extraction.destroy().catch(() => undefined);

            const extractionStartedAt = performance.now();

            try {
                // Checked before reading, so an oversized file is never pulled into memory first.
                const fileViolations = checkFileLimits(file.size);
                if (fileViolations.length > 0) {
                    setLoadError(describeLimitViolation(fileViolations[0]));
                    return;
                }

                // The signal is what actually stops the work: without it a superseded load ran to
                // completion and was then thrown away, which on a large document is the entire
                // cost of opening it paid twice.
                const extraction = await extractPdfText(new Uint8Array(await file.arrayBuffer()), { signal: loadController.signal });
                // The document was replaced while this one was loading.
                if (currentDocumentIdRef.current !== documentId) {
                    await extraction.destroy().catch(() => undefined);
                    return;
                }

                const segments = buildSegments(extraction.pages.map((page) => ({ pageNumber: page.pageNumber, lines: page.lines })));

                if (segments.length === 0) {
                    await extraction.destroy().catch(() => undefined);
                    setLoadError("No text could be extracted. This proof of concept requires a text-based PDF and does not run OCR.");
                    return;
                }

                setLoaded({
                    documentId,
                    fileName: file.name,
                    extraction,
                    segments,
                    pageIndexes: buildPageIndexes(extraction.pages),
                    limitViolations: checkSegmentLimits(segments),
                    extractionMs: Math.round(performance.now() - extractionStartedAt),
                });
            } catch (error) {
                // Guarded like the success path: a rejection from a superseded load must not
                // replace the message belonging to the document now on screen.
                if (currentDocumentIdRef.current !== documentId) return;
                if ((error as Error | undefined)?.name === "AbortError") return;

                if (error instanceof PageCountExceededError) {
                    setLoadError(describeLimitViolation(error.violation));
                    return;
                }

                const name = (error as Error | undefined)?.name ?? "Error";
                setLoadError(LOAD_ERROR_TEXT[name] ?? "This PDF could not be opened.");
            } finally {
                if (currentDocumentIdRef.current === documentId) setIsLoading(false);
            }
        },
        [loaded, resetSearchState],
    );

    useEffect(() => {
        const query = window.matchMedia(`(max-width: ${SINGLE_PANE_WIDTH - 1}px)`);
        const apply = () => setIsNarrow(query.matches);

        apply();
        query.addEventListener("change", apply);
        return () => query.removeEventListener("change", apply);
    }, []);

    /**
     * Whether the reader has chosen a passage themselves.
     *
     * Until they have, re-ranking may move the selection to whatever is now first; once they have,
     * it stays where they put it — including when the final response lands, which used to reset the
     * selection to the top and undo their choice at the last moment.
     *
     * A ref rather than state because the streaming callback is created once per search and would
     * otherwise keep reading the value captured when it was made.
     */
    const hasChosenResultRef = useRef(false);
    const selectResult = useCallback((key: string) => {
        hasChosenResultRef.current = true;
        setSelectedKey(key);
        // On a narrow screen choosing a passage means "take me to it"; the pane control is the way
        // back. On a wide one both panes are already visible and nothing moves.
        setNarrowPane("document");
    }, []);

    /** Stops loading the document currently being opened, so a slow import can be abandoned. */
    const cancelLoad = useCallback(() => {
        loadAbortRef.current?.abort();
        loadAbortRef.current = null;
        currentDocumentIdRef.current = "";
        setIsLoading(false);
    }, []);

    const runSearch = useCallback(
        async (searchMode: SearchMode) => {
            if (loaded === null) return;

            // Supersede any search already running, including an exact one: otherwise an in-flight
            // meaning response could land after a newer exact search and replace its results.
            abortRef.current?.abort();
            abortRef.current = null;

            const requestId = crypto.randomUUID();
            const documentId = loaded.documentId;
            currentRequestIdRef.current = requestId;

            resetSearchState();
            // Recorded with the results, so the panel describes what was searched rather than
            // whatever is in the box by the time the answer arrives.
            setSubmitted({ query, mode: searchMode });
            // Searching is a request to be shown the answers, so a narrow screen turns to them.
            setNarrowPane("results");
            const searchStartedAt = performance.now();

            if (searchMode === "exact") {
                const outcome = exactSearch(loaded.pageIndexes, query);

                if (!outcome.ok) {
                    setSearchError("Enter a query before searching.");
                    return;
                }

                // Still guarded: the document may have been replaced while this ran.
                if (currentRequestIdRef.current !== requestId || currentDocumentIdRef.current !== documentId) return;

                setStatus(outcome.hits.length > 0 ? "matched" : "no_match");
                // Every occurrence is shown: the three-result cap in spec §2 is about ranked
                // relevance, which exact search does not produce.
                setResults(outcome.hits);
                setSelectedKey(outcome.hits[0]?.key ?? null);
                setSearchMs(Math.round(performance.now() - searchStartedAt));
                return;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            setIsSearching(true);

            const byId = new Map(loaded.segments.map((segment) => [segment.id, segment]));
            const toHits = (records: readonly SearchResultRecord[]): SearchHit[] =>
                records
                    .map((record) => ({ record, segment: byId.get(record.segmentId) }))
                    .filter((entry): entry is { record: SearchResultRecord; segment: PdfSegment } => entry.segment !== undefined)
                    .map(({ record, segment }): SearchHit => ({
                        key: segment.id,
                        pageNumber: segment.pageNumber,
                        // Meaning results address whole items: the evidence is the segment.
                        ranges: segment.ranges,
                        previewText: segment.originalText,
                        segmentId: segment.id,
                        judgement: record,
                    }));

            try {
                const outcome = await requestSemanticSearch(buildSearchRequest(documentId, requestId, query, loaded.segments), controller.signal, (update) => {
                    // Guarded like the final response: a partial result from a superseded
                    // search must not reach the screen either.
                    if (currentDocumentIdRef.current !== documentId || currentRequestIdRef.current !== requestId) return;

                    setProgress({ evaluated: update.evaluated, total: update.total });
                    const next = toHits(update.results);
                    setResults(next);
                    // Follows the ranking until the reader picks a passage, then stays where they
                    // put it — and it is a key, so re-ranking cannot silently move it elsewhere.
                    setSelectedKey((current) => {
                        if (hasChosenResultRef.current && current !== null && next.some((hit) => hit.key === current)) return current;
                        return next[0]?.key ?? current;
                    });
                });

                if (controller.signal.aborted) return;
                if (currentDocumentIdRef.current !== documentId) return;
                if (currentRequestIdRef.current !== requestId) return;

                if (!outcome.ok) {
                    // A failed search has no results, whatever arrived before it failed. Leaving
                    // the provisional list highlighted under a panel that says the search could
                    // not be completed offers the reader a passage nothing stands behind.
                    setResults([]);
                    setSelectedKey(null);
                    setEvaluations(null);
                    setSearchError(ERROR_TEXT[outcome.code] ?? "The search could not be completed.");
                    return;
                }

                // Spec §9.3: ignore a response whose identifiers do not match current state.
                if (outcome.response.documentId !== currentDocumentIdRef.current || outcome.response.requestId !== currentRequestIdRef.current) {
                    return;
                }

                const views = toHits(outcome.response.results);

                setProgress(null);
                setStatus(outcome.response.status);
                setResults(views);
                setEvaluations(new Map((outcome.response.evaluations ?? []).map((record) => [record.segmentId, record])));
                setLastSearchCost({ questions: loaded.segments.length, requests: outcome.response.requestCount });
                // A reader who chose a passage while the search was still running keeps it, as
                // long as the final ranking still contains it. This used to reset to the top and
                // undo their choice at the last moment.
                setSelectedKey((current) =>
                    hasChosenResultRef.current && current !== null && views.some((hit) => hit.key === current) ? current : (views[0]?.key ?? null),
                );
                setSearchMs(Math.round(performance.now() - searchStartedAt));
            } catch (error) {
                if ((error as Error | undefined)?.name === "AbortError") return;
                // Guarded like the success path. No test covers it: superseding a search aborts
                // it, so a stale rejection arrives as `AbortError` and returns above. The guard
                // exists so the invariant survives a future path that supersedes without aborting.
                if (currentDocumentIdRef.current !== documentId) return;
                if (currentRequestIdRef.current !== requestId) return;
                setResults([]);
                setSelectedKey(null);
                setEvaluations(null);
                setSearchError("The search could not be completed.");
            } finally {
                // Keyed on the request rather than on the abort flag: an aborted search whose
                // controller never resolves would otherwise leave the button spinning forever.
                if (currentRequestIdRef.current === requestId) {
                    setIsSearching(false);
                    setProgress(null);
                }
            }
        },
        [loaded, query, resetSearchState],
    );

    /**
     * The scale actually rendered: the reader's choice, or the width of the viewport when they
     * have not made one.
     *
     * 100% left a page sitting in a field of grey on a wide screen. Fitting the width by default
     * makes the document the thing on screen and demotes zoom to an adjustment; pressing the
     * percentage goes back to fitting.
     */
    const effectiveScale = scale ?? fitScale;

    useEffect(() => {
        const element = viewerRef.current;
        if (element === null || loaded === null) return;

        let cancelled = false;
        let unscaledWidth = 0;

        const apply = () => {
            const available = element.clientWidth;
            if (cancelled || unscaledWidth <= 0 || available <= 0) return;
            // 48px of gutter, matching the padding the viewer puts around a page — but never more
            // than the pane has, or a narrow screen computes a negative width and clamps to 0.5.
            const usable = Math.max(available * 0.8, available - 48);
            setFitScale(Math.min(3, Math.max(0.2, round(usable / unscaledWidth))));
        };

        void loaded.extraction.document
            .getPage(1)
            .then((page) => {
                if (cancelled) return;
                unscaledWidth = page.getViewport({ scale: 1 }).width;
                apply();
            })
            .catch(() => undefined);

        const observer = new ResizeObserver(apply);
        observer.observe(element);
        return () => {
            cancelled = true;
            observer.disconnect();
        };
    }, [loaded]);

    /**
     * Drag handling stays on the pointer that started it: capturing the pointer keeps the drag
     * alive over the PDF canvas, which would otherwise swallow the move events.
     */
    const startPanelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const offset = event.clientX - handle.getBoundingClientRect().left;
        const origin = handle.parentElement?.getBoundingClientRect().left ?? 0;

        handle.setPointerCapture(event.pointerId);

        const move = (moveEvent: PointerEvent) => setPanelWidth(clampPanelWidth(moveEvent.clientX - offset - origin));
        const stop = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", stop);
            handle.removeEventListener("pointercancel", stop);
        };

        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
    }, []);

    const limitMessage = useMemo(() => {
        if (loaded === null) return undefined;

        // Extraction gave up partway. The document is far over the character limit and could not be
        // searched in any case, but the text that exists is partial and saying so is the point: an
        // incomplete extraction presented as the whole document is the one thing spec §10 forbids
        // outright.
        const stoppedAt = loaded.extraction.extractionStoppedAtPage;
        if (stoppedAt !== undefined) {
            return `This PDF carries more text than can be read. Extraction stopped at page ${stoppedAt}, so the extracted text is incomplete. Search is unavailable for this document.`;
        }

        if (loaded.limitViolations.length === 0) return undefined;
        return `${describeLimitViolation(loaded.limitViolations[0])} Search is unavailable for this document.`;
    }, [loaded]);

    /**
     * Pages that produced nothing to search. Reported with the result, not only in the status bar:
     * "no relevant passage" must not be read as "the document does not say".
     */
    const unsearchedPages = useMemo(
        () => (loaded === null ? [] : [...new Set([...loaded.extraction.pagesWithoutText, ...loaded.extraction.rotatedPages])].sort((a, b) => a - b)),
        [loaded],
    );

    /**
     * Pages whose layout spec §2 does not claim to handle. Searched, but with a reading order
     * that may be wrong — so they are reported separately from the pages that were not searched.
     */
    const unsupportedLayoutPages = useMemo(() => (loaded === null ? [] : loaded.extraction.multiColumnPages), [loaded]);

    const highlightMessage = useMemo(() => {
        if (highlightFailure === null) return null;
        return "This passage could not be located in the rendered page, so it is not highlighted.";
    }, [highlightFailure]);

    const highlightedHit = results.find((hit) => hit.key === selectedKey) ?? null;

    const pageSummary =
        loaded === null
            ? null
            : [
                  `${loaded.segments.length} searchable segments`,
                  ...(loaded.extraction.pagesWithoutText.length > 0 ? [`no text on page ${loaded.extraction.pagesWithoutText.join(", ")}`] : []),
                  ...(loaded.extraction.rotatedPages.length > 0 ? [`unsupported rotation on page ${loaded.extraction.rotatedPages.join(", ")}`] : []),
                  ...(loaded.extraction.multiColumnPages.length > 0 ? [`side-by-side text on page ${loaded.extraction.multiColumnPages.join(", ")}`] : []),
                  `extracted in ${loaded.extractionMs} ms`,
                  ...(searchMs === null ? [] : [`searched in ${searchMs} ms`]),
                  // What the last meaning search cost, so the batching can be judged while it is
                  // still being tuned. One question is asked per evaluated segment.
                  ...(lastSearchCost === null ? [] : [`${lastSearchCost.questions} Jev questions in ${lastSearchCost.requests} API calls`]),
              ].join(" · ");

    return (
        <div className="flex h-dvh justify-center bg-primary">
            <div className="flex w-full max-w-300 flex-col">
                <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pt-5 pb-3">
                    <div className="flex min-w-0 items-baseline gap-3">
                        <h1 className="shrink-0 text-lg font-semibold tracking-tight text-primary">PDF Semantic Finder</h1>
                        {/*
                         * Which document is open belongs beside the title, not in the status bar
                         * at the foot of the screen with the timings — one is what the reader is
                         * working on, the others are how the machine got on.
                         */}
                        {loaded !== null && (
                            <p className="truncate text-sm text-tertiary">
                                {loaded.fileName} · {loaded.extraction.pageCount} pages
                            </p>
                        )}
                    </div>
                    {/*
                     * Open PDF appears only once a document is open. Before that the drop zone is
                     * the single affordance on the screen, and a second way to do the same thing
                     * beside an empty page is noise.
                     */}
                    {loaded !== null && (
                        <div className="flex shrink-0 items-center gap-2">
                            {/* The input is visually hidden but still focusable, so the ring is drawn on the label. */}
                            <label className="inline-flex rounded-lg outline-brand focus-within:outline-2 focus-within:outline-offset-2">
                                <input
                                    type="file"
                                    accept="application/pdf,.pdf"
                                    className="sr-only"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file !== undefined) void openDocument(file);
                                        event.target.value = "";
                                    }}
                                />
                                <span className="cursor-pointer rounded-lg bg-brand-solid px-3.5 py-2 text-sm font-semibold text-white transition duration-100 ease-linear hover:bg-brand-solid_hover">
                                    Open PDF
                                </span>
                            </label>
                        </div>
                    )}
                </header>

                <div className="px-6 pb-4">
                    <SearchBar
                        query={query}
                        onQueryChange={setQuery}
                        mode={mode}
                        onModeChange={setMode}
                        onSubmit={() => void runSearch(mode)}
                        isSearching={isSearching}
                        isDisabled={loaded === null || limitMessage !== undefined}
                        disabledReason={limitMessage}
                    />
                </div>

                {/*
                 * One pane at a time below the breakpoint. Both stay mounted and the inactive one
                 * is hidden rather than unmounted: tearing the viewer down would drop every canvas
                 * and text layer, and with them the reader's place in the document — the same
                 * reason the extracted-text view is layered over it instead of replacing it.
                 */}
                {loaded !== null && isNarrow && (
                    <div role="radiogroup" aria-label="Pane" className="mx-6 mb-3 inline-flex self-start rounded-lg bg-secondary p-0.5">
                        {(["results", "document"] as const).map((pane) => (
                            <button
                                key={pane}
                                type="button"
                                role="radio"
                                aria-checked={narrowPane === pane}
                                onClick={() => setNarrowPane(pane)}
                                className={cx(
                                    "cursor-pointer rounded-md px-3 py-1.5 text-sm font-semibold capitalize outline-brand transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-1",
                                    narrowPane === pane ? "bg-primary text-primary shadow-xs" : "text-tertiary hover:text-secondary",
                                )}
                            >
                                {pane}
                            </button>
                        ))}
                    </div>
                )}

                <main className="flex min-h-0 flex-1">
                    {loaded !== null && (
                        <>
                            <aside
                                hidden={isNarrow && narrowPane !== "results"}
                                className={cx("flex flex-col", isNarrow ? "min-w-0 flex-1" : "shrink-0")}
                                style={isNarrow ? undefined : { width: panelWidth }}
                            >
                                <SearchResults
                                    hasDocument={loaded !== null}
                                    status={status}
                                    results={results}
                                    selectedKey={selectedKey}
                                    onSelect={selectResult}
                                    errorMessage={searchError}
                                    locationErrorMessage={highlightMessage}
                                    unsearchedPages={unsearchedPages}
                                    unsupportedLayoutPages={unsupportedLayoutPages}
                                    mode={submitted?.mode ?? mode}
                                    query={submitted?.query ?? ""}
                                    progress={progress}
                                    isShowingExtractedText={showExtractedText}
                                    onToggleExtractedText={() => setShowExtractedText((value) => !value)}
                                />
                            </aside>

                            {/*
                             * A separator, not a scrollbar: a long passage and a wide page want
                             * different splits, and the reader is the one who knows which.
                             * Keyboard-operable because a pointer drag is not an accessible
                             * control on its own.
                             */}
                            <div
                                // The divider only makes sense when both panes are on screen.
                                hidden={isNarrow}
                                role="separator"
                                aria-label="Resize results panel"
                                aria-orientation="vertical"
                                aria-valuenow={panelWidth}
                                aria-valuemin={MIN_PANEL_WIDTH}
                                aria-valuemax={MAX_PANEL_WIDTH}
                                tabIndex={0}
                                onPointerDown={startPanelDrag}
                                onKeyDown={(event) => {
                                    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
                                    if (step === 0) return;
                                    event.preventDefault();
                                    setPanelWidth((width) => clampPanelWidth(width + step));
                                }}
                                className="group relative w-1.5 shrink-0 cursor-col-resize outline-brand focus-visible:outline-2 focus-visible:-outline-offset-2"
                            >
                                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-secondary transition-colors duration-100 group-hover:bg-border-brand" />
                            </div>
                        </>
                    )}

                    <section hidden={loaded !== null && isNarrow && narrowPane !== "document"} className="relative flex min-w-0 flex-1 flex-col">
                        {loaded === null ? (
                            <div className="flex flex-1 items-center justify-center p-8">
                                {isLoading ? (
                                    <div className="flex flex-col items-center gap-3">
                                        <p className="text-sm text-tertiary">Opening the document…</p>
                                        {/*
                                         * A large PDF takes real time to extract, and until now the
                                         * only way out was to reload the page. Cancelling stops the
                                         * work rather than hiding it.
                                         */}
                                        <Button size="sm" color="tertiary" onClick={cancelLoad}>
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="w-full max-w-120">
                                        <FileUploadDropZone
                                            className="border-transparent bg-secondary"
                                            accept="application/pdf,.pdf"
                                            allowsMultiple={false}
                                            maxSize={LIMITS.maxFileBytes}
                                            hint={`PDF up to ${LIMITS.maxFileBytes / (1024 * 1024)} MB and ${LIMITS.maxPageCount} pages`}
                                            onDropFiles={(files) => {
                                                const file = files[0];
                                                if (file !== undefined) void openDocument(file);
                                            }}
                                            // Without these the drop zone discards rejected files in
                                            // silence, so an oversized or non-PDF drop would look like
                                            // nothing happened.
                                            onSizeLimitExceed={(files) => {
                                                const file = files[0];
                                                setLoadError(
                                                    file === undefined
                                                        ? "That file is too large."
                                                        : describeLimitViolation({
                                                              kind: "file_size",
                                                              actual: file.size,
                                                              limit: LIMITS.maxFileBytes,
                                                          }),
                                                );
                                            }}
                                            onDropUnacceptedFiles={() => {
                                                setLoadError("Only PDF files can be opened.");
                                            }}
                                        />
                                        {loadError !== null && <p className="mt-3 text-sm text-error-primary">{loadError}</p>}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-0 flex-1 flex-col">
                                <div className="relative min-h-0 flex-1">
                                    <div ref={viewerRef} className="absolute inset-0 overflow-y-auto rounded-tl-2xl bg-secondary">
                                        <PdfViewer
                                            document={loaded.extraction.document}
                                            pages={loaded.extraction.pages}
                                            scale={effectiveScale}
                                            highlightedHit={highlightedHit}
                                            onHighlightFailure={setHighlightFailure}
                                            onVisiblePageChange={setVisiblePage}
                                        />
                                    </div>

                                    {/*
                                     * Layered over the viewer rather than replacing it. Unmounting the
                                     * viewer tears down every canvas and text layer, so looking at the
                                     * extraction would re-render the whole document and drop the reader
                                     * back at page 1 — losing the position a result had just navigated
                                     * to. The highlight itself is re-applied either way; the place in
                                     * the document is not.
                                     *
                                     * It covers the viewer only. Covering the control row underneath
                                     * would bury the button that dismisses it.
                                     */}
                                    {showExtractedText && (
                                        <div className="absolute inset-0 overflow-y-auto rounded-tl-2xl bg-primary">
                                            <ExtractedTextView
                                                segments={loaded.segments}
                                                evaluations={evaluations}
                                                onClose={() => setShowExtractedText(false)}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 bg-secondary px-5 py-2.5">
                                    <div className="flex items-center gap-2">
                                        {/* Which page the reader is on, which the scroll position alone does not say. */}
                                        <span className="text-sm text-tertiary tabular-nums">
                                            {visiblePage} / {loaded.extraction.pageCount}
                                        </span>
                                        <span className="mx-1 h-4 w-px bg-border-secondary" aria-hidden="true" />
                                        {/*
                                         * Secondary even when active: zoom is an adjustment to a
                                         * viewer that already fits, not something to draw the eye
                                         * away from the document.
                                         */}
                                        <Button
                                            size="sm"
                                            color={scale === null ? "secondary" : "tertiary"}
                                            aria-pressed={scale === null}
                                            onClick={() => setScale(null)}
                                        >
                                            Fit
                                        </Button>
                                        <Button size="sm" color="secondary" onClick={() => setScale(zoomOut(effectiveScale))} aria-label="Zoom out">
                                            −
                                        </Button>
                                        <span aria-label="Zoom level" className="w-12 text-center text-sm text-secondary tabular-nums">
                                            {Math.round(effectiveScale * 100)}%
                                        </span>
                                        <Button size="sm" color="secondary" onClick={() => setScale(zoomIn(effectiveScale))} aria-label="Zoom in">
                                            +
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>
                </main>

                {pageSummary !== null && (
                    <footer className="px-6 pt-2 pb-3">
                        <p className="text-xs text-quaternary">{pageSummary}</p>
                    </footer>
                )}
            </div>
        </div>
    );
};
