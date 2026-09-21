/**
 * Owns document and search state (spec §3, §9.3, §10).
 *
 * The staleness guard is the load-bearing part: identifiers are compared against refs holding the
 * current values, never against values captured when the search started. Comparing against a
 * captured identifier would always agree with itself, so results from a discarded PDF would render
 * against the new one — a silent wrong-passage failure rather than an error.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ExtractedTextView } from "@/components/extracted-text-view";
import { PdfViewer } from "@/components/pdf-viewer";
import { SearchBar } from "@/components/search-bar";
import { SearchResults } from "@/components/search-results";
import { buildSegments } from "@/lib/pdf/build-segments";
import type { LimitViolation } from "@/lib/pdf/check-limits";
import { checkFileLimits, checkPageLimits, checkSegmentLimits, describeLimitViolation } from "@/lib/pdf/check-limits";
import type { PdfExtraction } from "@/lib/pdf/extract-text";
import { extractPdfText } from "@/lib/pdf/extract-text";
import type { HighlightTargetFailure } from "@/lib/pdf/highlight";
import { buildPageIndexes } from "@/lib/pdf/page-index";
import type { PageIndex } from "@/lib/pdf/page-index";
import { exactSearch } from "@/lib/search/exact-search";
import { buildSearchRequest, requestSemanticSearch } from "@/lib/search/semantic-search";
import type { PdfSegment } from "@/lib/types";
import type { SearchErrorCode, SearchHit, SearchMode, SearchResultRecord, SearchStatus } from "@/lib/types";
import { LIMITS } from "@/lib/types";

/** No result is being shown in the viewer. */
const NO_SELECTION = -1;

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

/**
 * The segments a passage's `contextBefore` / `contextAfter` were taken from.
 *
 * `buildSegments` builds both from the adjacent groups on the same physical page, so the neighbour
 * is recoverable from position and nothing extra has to travel to the Worker and back.
 */
const neighbourContext = (segments: readonly PdfSegment[], segment: PdfSegment): Pick<SearchHit, "contextBefore" | "contextAfter"> => {
    const index = segments.indexOf(segment);
    const sameDocumentPage = (candidate: PdfSegment | undefined) =>
        candidate !== undefined && candidate.pageNumber === segment.pageNumber ? candidate : undefined;

    const before = segment.contextBefore === undefined ? undefined : sameDocumentPage(segments[index - 1]);
    const after = segment.contextAfter === undefined ? undefined : sameDocumentPage(segments[index + 1]);

    return {
        ...(before === undefined ? {} : { contextBefore: { segmentId: before.id, text: before.originalText } }),
        ...(after === undefined ? {} : { contextAfter: { segmentId: after.id, text: after.originalText } }),
    };
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
     * Index of the result being shown in the viewer, or `NO_SELECTION`.
     *
     * Any search that produced candidates opens its highest ranked one, uncertain included: the
     * reader asked to be taken to the passage, and the uncertain note above the list already says
     * how much weight to give it.
     */
    const [selectedIndex, setSelectedIndex] = useState(NO_SELECTION);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [searchMs, setSearchMs] = useState<number | null>(null);
    /**
     * Every segment's judgement from the last meaning search, for the extracted-text view.
     *
     * Cleared with the rest of the search state, so it can never describe a document or a query
     * that is no longer on screen.
     */
    const [evaluations, setEvaluations] = useState<Map<string, SearchResultRecord> | null>(null);
    const [highlightFailure, setHighlightFailure] = useState<HighlightTargetFailure | null>(null);

    const [scale, setScale] = useState(1);
    const [showExtractedText, setShowExtractedText] = useState(false);

    // Refs hold the authoritative current identifiers. They are updated synchronously, so a guard
    // reads the newest value even before React commits.
    const currentDocumentIdRef = useRef<string>("");
    const currentRequestIdRef = useRef<string>("");
    const abortRef = useRef<AbortController | null>(null);

    const resetSearchState = useCallback(() => {
        setIsSearching(false);
        setSearchMs(null);
        setStatus(null);
        setResults([]);
        setSelectedIndex(NO_SELECTION);
        setSearchError(null);
        setHighlightFailure(null);
        setEvaluations(null);
    }, []);

    const openDocument = useCallback(
        async (file: File) => {
            abortRef.current?.abort();
            abortRef.current = null;
            currentRequestIdRef.current = "";

            const previous = loaded;
            setLoaded(null);
            setLoadError(null);
            resetSearchState();
            setIsLoading(true);

            if (previous !== null) await previous.extraction.destroy().catch(() => undefined);

            const documentId = crypto.randomUUID();
            currentDocumentIdRef.current = documentId;

            const extractionStartedAt = performance.now();

            try {
                // Checked before reading, so an oversized file is never pulled into memory first.
                const fileViolations = checkFileLimits(file.size);
                if (fileViolations.length > 0) {
                    setLoadError(describeLimitViolation(fileViolations[0]));
                    return;
                }

                const extraction = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
                // The document was replaced while this one was loading.
                if (currentDocumentIdRef.current !== documentId) {
                    await extraction.destroy().catch(() => undefined);
                    return;
                }

                const pageViolations = checkPageLimits(extraction.pageCount);
                if (pageViolations.length > 0) {
                    await extraction.destroy().catch(() => undefined);
                    setLoadError(describeLimitViolation(pageViolations[0]));
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
                const name = (error as Error | undefined)?.name ?? "Error";
                setLoadError(LOAD_ERROR_TEXT[name] ?? "This PDF could not be opened.");
            } finally {
                setIsLoading(false);
            }
        },
        [loaded, resetSearchState],
    );

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
                setSelectedIndex(outcome.hits.length > 0 ? 0 : NO_SELECTION);
                setSearchMs(Math.round(performance.now() - searchStartedAt));
                return;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            setIsSearching(true);

            try {
                const outcome = await requestSemanticSearch(buildSearchRequest(documentId, requestId, query, loaded.segments), controller.signal);

                if (controller.signal.aborted) return;
                if (currentDocumentIdRef.current !== documentId) return;
                if (currentRequestIdRef.current !== requestId) return;

                if (!outcome.ok) {
                    setSearchError(ERROR_TEXT[outcome.code] ?? "The search could not be completed.");
                    return;
                }

                // Spec §9.3: ignore a response whose identifiers do not match current state.
                if (outcome.response.documentId !== currentDocumentIdRef.current || outcome.response.requestId !== currentRequestIdRef.current) {
                    return;
                }

                const byId = new Map(loaded.segments.map((segment) => [segment.id, segment]));
                const views = outcome.response.results
                    .map((record) => byId.get(record.segmentId))
                    .filter((segment): segment is PdfSegment => segment !== undefined)
                    .map((segment): SearchHit => ({
                        key: segment.id,
                        pageNumber: segment.pageNumber,
                        // Meaning results address whole items: the evidence is the segment.
                        ranges: segment.ranges,
                        previewText: segment.originalText,
                        segmentId: segment.id,
                        // Which segments the context strings came from, so the reader can be taken
                        // to them. Recovered from position rather than carried in the response:
                        // `buildSegments` takes context from the neighbours on the same page.
                        ...neighbourContext(loaded.segments, segment),
                    }));

                setStatus(outcome.response.status);
                setResults(views);
                setEvaluations(new Map((outcome.response.evaluations ?? []).map((record) => [record.segmentId, record])));
                setSelectedIndex(views.length > 0 ? 0 : NO_SELECTION);
                setSearchMs(Math.round(performance.now() - searchStartedAt));
            } catch (error) {
                if ((error as Error | undefined)?.name === "AbortError") return;
                // Guarded like the success path. No test covers it: superseding a search aborts
                // it, so a stale rejection arrives as `AbortError` and returns above. The guard
                // exists so the invariant survives a future path that supersedes without aborting.
                if (currentDocumentIdRef.current !== documentId) return;
                if (currentRequestIdRef.current !== requestId) return;
                setSearchError("The search could not be completed.");
            } finally {
                // Keyed on the request rather than on the abort flag: an aborted search whose
                // controller never resolves would otherwise leave the button spinning forever.
                if (currentRequestIdRef.current === requestId) setIsSearching(false);
            }
        },
        [loaded, query, resetSearchState],
    );

    /**
     * Opens a passage the reader reached through another result's context.
     *
     * It becomes the selected result rather than a search of its own: nothing is re-evaluated, and
     * the status and the rest of the list stay as the search left them. Its own neighbours travel
     * with it, so the reader can keep walking the document from there.
     */
    const openSegment = useCallback(
        (segmentId: string) => {
            if (loaded === null) return;
            const segment = loaded.segments.find((candidate) => candidate.id === segmentId);
            if (segment === undefined) return;

            const hit: SearchHit = {
                key: segment.id,
                pageNumber: segment.pageNumber,
                ranges: segment.ranges,
                previewText: segment.originalText,
                segmentId: segment.id,
                ...neighbourContext(loaded.segments, segment),
            };

            setResults((current) => {
                const existing = current.findIndex((entry) => entry.key === hit.key);
                if (existing >= 0) {
                    setSelectedIndex(existing);
                    return current;
                }
                setSelectedIndex(current.length);
                return [...current, hit];
            });
        },
        [loaded],
    );

    const limitMessage = useMemo(() => {
        if (loaded === null || loaded.limitViolations.length === 0) return undefined;
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

    const highlightedHit = results[selectedIndex] ?? null;

    const pageSummary =
        loaded === null
            ? null
            : [
                  loaded.fileName,
                  `${loaded.extraction.pageCount} pages`,
                  `${loaded.segments.length} searchable segments`,
                  ...(loaded.extraction.pagesWithoutText.length > 0 ? [`no text on page ${loaded.extraction.pagesWithoutText.join(", ")}`] : []),
                  ...(loaded.extraction.rotatedPages.length > 0 ? [`unsupported rotation on page ${loaded.extraction.rotatedPages.join(", ")}`] : []),
                  ...(loaded.extraction.multiColumnPages.length > 0 ? [`side-by-side text on page ${loaded.extraction.multiColumnPages.join(", ")}`] : []),
                  `extracted in ${loaded.extractionMs} ms`,
                  ...(searchMs === null ? [] : [`searched in ${searchMs} ms`]),
              ].join(" · ");

    return (
        <div className="flex h-dvh justify-center bg-primary">
            <div className="flex w-full max-w-300 flex-col">
                <header className="flex items-center justify-between px-6 pt-5 pb-3">
                    <h1 className="text-lg font-semibold tracking-tight text-primary">PDF Semantic Finder</h1>
                    {/*
                     * Both controls appear only once a document is open. Before that the drop zone
                     * is the single affordance on the screen, and a second way to do the same thing
                     * beside an empty page is noise.
                     */}
                    {loaded !== null && (
                        <div className="flex items-center gap-2">
                            <Button size="sm" color="tertiary" onClick={() => setShowExtractedText((value) => !value)}>
                                {showExtractedText ? "Hide extracted text" : "View extracted text"}
                            </Button>
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

                <main className="flex min-h-0 flex-1">
                    {loaded !== null && (
                        <aside className="flex w-84 shrink-0 flex-col">
                            <SearchResults
                                hasDocument={loaded !== null}
                                status={status}
                                results={results}
                                selectedIndex={selectedIndex}
                                onSelect={setSelectedIndex}
                                errorMessage={searchError}
                                locationErrorMessage={highlightMessage}
                                unsearchedPages={unsearchedPages}
                                unsupportedLayoutPages={unsupportedLayoutPages}
                                onOpenSegment={openSegment}
                                mode={mode}
                            />
                        </aside>
                    )}

                    <section className="relative flex min-w-0 flex-1 flex-col">
                        {loaded === null ? (
                            <div className="flex flex-1 items-center justify-center p-8">
                                {isLoading ? (
                                    <p className="text-sm text-tertiary">Opening the document…</p>
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
                                <div className="flex-1 overflow-y-auto rounded-tl-2xl bg-secondary">
                                    <PdfViewer
                                        document={loaded.extraction.document}
                                        pages={loaded.extraction.pages}
                                        scale={scale}
                                        highlightedHit={highlightedHit}
                                        onHighlightFailure={setHighlightFailure}
                                    />
                                </div>
                                <div className="flex items-center justify-end gap-2 bg-secondary px-5 py-2.5">
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        onClick={() => setScale((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))}
                                        aria-label="Zoom out"
                                    >
                                        −
                                    </Button>
                                    <span className="w-14 text-center text-sm text-secondary">{Math.round(scale * 100)}%</span>
                                    <Button
                                        size="sm"
                                        color="secondary"
                                        onClick={() => setScale((value) => Math.min(3, Number((value + 0.25).toFixed(2))))}
                                        aria-label="Zoom in"
                                    >
                                        +
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/*
                         * Layered over the viewer rather than replacing it. Unmounting the viewer
                         * tears down every canvas and text layer, so looking at the extraction
                         * would re-render the whole document and drop the reader back at page 1 —
                         * losing the position a result had just navigated to. The highlight
                         * itself is re-applied either way; the place in the document is not.
                         */}
                        {loaded !== null && showExtractedText && (
                            <div className="absolute inset-0 overflow-y-auto rounded-tl-2xl bg-primary">
                                <ExtractedTextView segments={loaded.segments} evaluations={evaluations} />
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
