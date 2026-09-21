/**
 * Canvas and text-layer viewer (spec §8).
 *
 * Every page is rendered eagerly and each page's `TextLayer` is created exactly once per
 * document. That is what the highlighting contract rests on: an applied highlight survives a zoom
 * change because `TextLayer.update()` re-lays out the same span elements rather than rebuilding
 * them. The PoC is capped at ten pages, so eager rendering costs little and removes the need to
 * re-create a layer when the reader navigates.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { OutputScale, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { PageExtraction } from "@/lib/pdf/extract-text";
import type { AppliedHighlight, HighlightTargetFailure } from "@/lib/pdf/highlight";
import { applyHighlight, clearHighlight, resolveHighlightTargets } from "@/lib/pdf/highlight";
import type { SearchHit } from "@/lib/types";
import { cx } from "@/utils/cx";

export type PdfViewerProps = {
    document: PDFDocumentProxy;
    pages: PageExtraction[];
    scale: number;
    /** The passage to highlight, or null to clear the highlight. */
    highlightedHit: SearchHit | null;
    /** Reported when a segment cannot be located; the result is kept and the failure shown. */
    onHighlightFailure: (failure: HighlightTargetFailure | null) => void;
};

type PageRecord = {
    page: PDFPageProxy;
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    textLayer: TextLayer;
    isRendered: boolean;
    /** The scale this page is currently drawn at, so a stale one can be detected and corrected. */
    appliedScale: number;
    /**
     * The canvas render in flight, if any.
     *
     * PDF.js v6 no longer refuses a second render to the same canvas, so two overlapping renders
     * both draw to it and the one that finishes last wins. Retaining the task lets the previous one
     * be cancelled before the next starts.
     */
    renderTask: RenderTask | null;
};

/** Cancellation is expected whenever a render is superseded, and is not a failure to report. */
const ignoreCancellation = (error: unknown): void => {
    const name = (error as Error | undefined)?.name;
    if (name !== "RenderingCancelledException" && name !== "AbortException") throw error;
};

/**
 * Approximates a device-pixel ratio as a fraction, so the page box can be rounded to whole device
 * pixels. Without it the canvas and the text layer drift by a subpixel at fractional zoom levels.
 */
const approximateFraction = (value: number): [number, number] => {
    if (Number.isInteger(value)) return [value, 1];

    const inverse = 1 / value;
    if (inverse > 8) return [1, 8];
    if (Number.isInteger(inverse)) return [1, inverse];

    const limit = value > 1 ? Math.floor(value) : 1;
    let x = 0;
    let y = 1;
    let a = 1;
    let b = 1;

    for (;;) {
        const candidate = (x + a) / (y + b);
        if (candidate > value) {
            a += x;
            b += y;
        } else {
            x += a;
            y += b;
            if (y > 8 * limit) break;
        }
    }

    return value - x / y < a / b - value ? (y > 8 * limit ? [1, 8] : [x, y]) : [a, b];
};

/**
 * Writes the CSS variables the PDF.js text layer depends on.
 *
 * `pdf_viewer.css` only defines these on `.pdfViewer .page`. `setLayerDimensions()` emits
 * `round(down, var(--total-scale-factor) * …px, var(--scale-round-x))`, so leaving any of them
 * undefined makes the whole declaration invalid and collapses the text layer to zero size —
 * silently, with no error.
 */
const applyPageVariables = (container: HTMLElement, scale: number, userUnit: number, outputScale: OutputScale): void => {
    const [, roundX] = approximateFraction(outputScale.sx);
    const [, roundY] = approximateFraction(outputScale.sy);

    container.style.setProperty("--scale-factor", `${scale}`);
    container.style.setProperty("--user-unit", `${userUnit}`);
    container.style.setProperty("--total-scale-factor", "calc(var(--scale-factor) * var(--user-unit))");
    container.style.setProperty("--scale-round-x", `${roundX}px`);
    container.style.setProperty("--scale-round-y", `${roundY}px`);
};

export const PdfViewer = ({ document, pages, scale, highlightedHit, onHighlightFailure }: PdfViewerProps) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const recordsRef = useRef<Map<number, PageRecord>>(new Map());
    const highlightedElementsRef = useRef<AppliedHighlight[]>([]);
    /** The passage the viewer last scrolled to, so a later page finishing does not yank it back. */
    const scrolledToRef = useRef<string | null>(null);
    const [renderGeneration, setRenderGeneration] = useState(0);

    // The build loop is asynchronous and must not draw pages at a zoom level the reader has
    // already left. Reading the live value through a ref keeps it from capturing a stale one.
    const scaleRef = useRef(scale);
    scaleRef.current = scale;

    // Builds every page once per document. Re-running on `scale` would rebuild the text layers and
    // discard the element identities the highlight depends on.
    useEffect(() => {
        const root = rootRef.current;
        if (root === null) return;

        let cancelled = false;
        const records = new Map<number, PageRecord>();
        recordsRef.current = records;
        root.replaceChildren();

        const build = async () => {
            for (const extraction of pages) {
                if (cancelled) return;

                const page = await document.getPage(extraction.pageNumber);
                if (cancelled) return;

                const buildScale = scaleRef.current;
                const viewport = page.getViewport({ scale: buildScale });
                const outputScale = new OutputScale();

                const container = window.document.createElement("div");
                container.className = "pdf-finder-page";
                container.dataset.pageNumber = String(extraction.pageNumber);
                applyPageVariables(container, buildScale, viewport.userUnit, outputScale);
                container.style.width = `${viewport.width}px`;
                container.style.height = `${viewport.height}px`;

                const canvasWrapper = window.document.createElement("div");
                canvasWrapper.className = "pdf-finder-canvas-wrapper";
                const canvas = window.document.createElement("canvas");
                canvasWrapper.append(canvas);

                const textLayerElement = window.document.createElement("div");
                textLayerElement.className = "textLayer";

                container.append(canvasWrapper, textLayerElement);
                root.append(container);

                const textLayer = new TextLayer({
                    // The identical object extraction used, which is what keeps `textDivs`
                    // index-aligned with `textContent.items`.
                    textContentSource: extraction.textContent,
                    container: textLayerElement,
                    viewport,
                });

                const record: PageRecord = {
                    page,
                    canvas,
                    container,
                    textLayer,
                    isRendered: false,
                    appliedScale: buildScale,
                    renderTask: null,
                };
                records.set(extraction.pageNumber, record);

                canvas.width = Math.floor(viewport.width * outputScale.sx);
                canvas.height = Math.floor(viewport.height * outputScale.sy);

                record.renderTask = page.render({
                    canvas,
                    viewport,
                    transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : undefined,
                });
                await record.renderTask.promise;
                record.renderTask = null;

                await textLayer.render();
                if (cancelled) return;

                record.isRendered = true;
                setRenderGeneration((generation) => generation + 1);
            }
        };

        build().catch((error: unknown) => {
            // Cancellation is ordinary control flow when a document is replaced mid-render.
            const name = (error as Error | undefined)?.name;
            if (name === "AbortException" || name === "RenderingCancelledException") return;
            if (!cancelled) console.error("Page rendering failed", name);
        });

        return () => {
            cancelled = true;
            for (const record of records.values()) {
                record.renderTask?.cancel();
                record.textLayer.cancel();
            }
            highlightedElementsRef.current = [];
        };
        // `scale` is deliberately omitted: zoom is handled by the effect below, which updates the
        // existing layers instead of rebuilding them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [document, pages]);

    // Zoom. The canvas is re-rendered and the text layer is updated in place.
    //
    // This also runs on `renderGeneration`, so a page that finished building after the reader
    // changed zoom is corrected as soon as it exists. Without that, zooming during a multi-page
    // load leaves the later pages drawn at the old scale for good, and any highlight on them is
    // positioned against the wrong viewport.
    useEffect(() => {
        for (const record of recordsRef.current.values()) {
            if (!record.isRendered || record.appliedScale === scale) continue;

            record.appliedScale = scale;
            // Supersede the previous draw before resizing the canvas, so an older render cannot
            // finish last and leave the page drawn at the wrong scale.
            record.renderTask?.cancel();

            const viewport = record.page.getViewport({ scale });
            const outputScale = new OutputScale();

            applyPageVariables(record.container, scale, viewport.userUnit, outputScale);
            record.container.style.width = `${viewport.width}px`;
            record.container.style.height = `${viewport.height}px`;
            record.canvas.width = Math.floor(viewport.width * outputScale.sx);
            record.canvas.height = Math.floor(viewport.height * outputScale.sy);

            const task = record.page.render({
                canvas: record.canvas,
                viewport,
                transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : undefined,
            });
            record.renderTask = task;
            void task.promise
                .then(() => {
                    if (record.renderTask === task) record.renderTask = null;
                })
                .catch(ignoreCancellation);

            // Required, not optional: the per-span horizontal correction goes stale if only the
            // CSS variable changes, which shows up as visible drift on Japanese text at 125%.
            record.textLayer.update({ viewport });
        }
    }, [scale, renderGeneration]);

    const scrollToPage = useCallback((pageNumber: number) => {
        recordsRef.current.get(pageNumber)?.container.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    // Highlighting. Depends on `renderGeneration` so a highlight requested before its page
    // finished rendering is applied as soon as the layer is ready.
    useEffect(() => {
        clearHighlight(highlightedElementsRef.current);
        highlightedElementsRef.current = [];

        if (highlightedHit === null) {
            scrolledToRef.current = null;
            onHighlightFailure(null);
            return;
        }

        const record = recordsRef.current.get(highlightedHit.pageNumber);
        const extraction = pages.find((page) => page.pageNumber === highlightedHit.pageNumber);

        if (record === undefined || extraction === undefined) {
            onHighlightFailure({ reason: "layer_not_ready" });
            return;
        }

        const resolved = resolveHighlightTargets(record.textLayer, extraction.textContent, highlightedHit.ranges, record.isRendered);

        if (!resolved.ok) {
            // The result is kept; only the display of its location failed (spec §8).
            onHighlightFailure(resolved.failure);
            return;
        }

        highlightedElementsRef.current = applyHighlight(resolved.targets);
        onHighlightFailure(null);

        if (scrolledToRef.current !== highlightedHit.key) {
            scrolledToRef.current = highlightedHit.key;
            scrollToPage(highlightedHit.pageNumber);
        }
    }, [highlightedHit, pages, renderGeneration, onHighlightFailure, scrollToPage]);

    return <div ref={rootRef} className={cx("flex flex-col items-center gap-6 p-6")} />;
};
