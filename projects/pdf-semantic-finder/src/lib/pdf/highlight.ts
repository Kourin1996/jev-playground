/**
 * Highlighting by source item index (spec §8).
 *
 *     segment ID → page + item indexes → text-layer elements → highlight class
 *
 * A passage is never located by searching the rendered text for a matching string: repeated text
 * would resolve to the wrong occurrence. When the mapping cannot be trusted the caller is told so,
 * and the result is kept with a location error instead of a guessed highlight (spec §8, §10).
 */
import type { TextContent } from "pdfjs-dist/types/src/display/api";

/**
 * Deliberately not `highlight`: `pdf_viewer.css` already styles `.textLayer .highlight` for the
 * find controller, and reusing it would inherit that appearance.
 */
export const HIGHLIGHT_CLASS = "pdf-finder-highlight";

/** The parts of a rendered `TextLayer` this module depends on. */
export type RenderedTextLayer = {
    textDivs: HTMLElement[];
    textContentItemsStr: string[];
};

export type HighlightTargetFailure =
    { reason: "layer_not_ready" } | { reason: "element_count_mismatch"; expected: number; actual: number } | { reason: "content_mismatch"; itemIndex: number };

export type HighlightTargetResult = { ok: true; elements: HTMLElement[] } | { ok: false; failure: HighlightTargetFailure };

/**
 * Resolves the elements a segment should highlight, or explains why it cannot.
 *
 * PDF.js pushes exactly one element onto `textDivs` for every item that has a `str` and skips
 * marked-content items; extraction requests `includeMarkedContent: false`, so the arrays are
 * index-parallel. Three things can still break that:
 *
 * - the layer has not finished rendering, so `textDivs` is only partly filled;
 * - `MAX_TEXT_DIVS_TO_RENDER` was reached, after which PDF.js stops silently and truncates;
 * - the layer was built from a different `TextContent` than the one extraction used.
 *
 * The first two show up as a length mismatch. The third can survive a length check, so the item
 * strings at the segment's own boundaries are compared against `textContentItemsStr` as well.
 */
export const resolveHighlightTargets = (
    layer: RenderedTextLayer,
    textContent: TextContent,
    itemIndexes: readonly number[],
    isRendered: boolean,
): HighlightTargetResult => {
    if (!isRendered) return { ok: false, failure: { reason: "layer_not_ready" } };

    if (layer.textDivs.length !== textContent.items.length) {
        return {
            ok: false,
            failure: {
                reason: "element_count_mismatch",
                expected: textContent.items.length,
                actual: layer.textDivs.length,
            },
        };
    }

    const elements: HTMLElement[] = [];

    for (const itemIndex of itemIndexes) {
        const item = textContent.items[itemIndex] as { str?: string } | undefined;
        const element = layer.textDivs[itemIndex];

        if (item?.str === undefined || element === undefined) {
            return { ok: false, failure: { reason: "content_mismatch", itemIndex } };
        }

        if (layer.textContentItemsStr[itemIndex] !== item.str) {
            return { ok: false, failure: { reason: "content_mismatch", itemIndex } };
        }

        // Items whose string was empty get an element PDF.js never inserts into the DOM. They
        // carry no visible text, so highlighting them would be a silent no-op.
        if (element.isConnected) elements.push(element);
    }

    return { ok: true, elements };
};

/** Applies the highlight class. The caller keeps the returned elements so it can clear exactly those. */
export const applyHighlight = (elements: readonly HTMLElement[]): HTMLElement[] => {
    for (const element of elements) element.classList.add(HIGHLIGHT_CLASS);
    return [...elements];
};

/** Removes a previously applied highlight. Always called before applying the next one (spec §8). */
export const clearHighlight = (elements: readonly HTMLElement[]): void => {
    for (const element of elements) element.classList.remove(HIGHLIGHT_CLASS);
};
