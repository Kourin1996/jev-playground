/**
 * Highlighting by source item index and character offset (spec §8).
 *
 *     result → page + text ranges → text-layer elements → highlight class
 *
 * A passage is never located by searching the rendered text for a matching string: repeated text
 * would resolve to the wrong occurrence. When the mapping cannot be trusted the caller is told so,
 * and the result is kept with a location error instead of a guessed highlight (spec §8, §10).
 */
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { TextRange } from "@/lib/types";

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

/** One element to mark, and which of its characters. */
export type HighlightTarget = {
    element: HTMLElement;
    /** The item's full text, so it can be restored when the highlight is cleared. */
    text: string;
    startOffset: number;
    endOffset: number;
    wholeItem: boolean;
};

export type HighlightTargetResult = { ok: true; targets: HighlightTarget[] } | { ok: false; failure: HighlightTargetFailure };

/**
 * Resolves what a result should highlight, or explains why it cannot.
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
 * strings at the result's own ranges are compared against `textContentItemsStr` as well.
 */
export const resolveHighlightTargets = (
    layer: RenderedTextLayer,
    textContent: TextContent,
    ranges: readonly TextRange[],
    isRendered: boolean,
): HighlightTargetResult => {
    if (!isRendered) return { ok: false, failure: { reason: "layer_not_ready" } };

    if (layer.textDivs.length !== textContent.items.length) {
        return {
            ok: false,
            failure: { reason: "element_count_mismatch", expected: textContent.items.length, actual: layer.textDivs.length },
        };
    }

    const targets: HighlightTarget[] = [];

    for (const range of ranges) {
        const item = textContent.items[range.itemIndex] as { str?: string } | undefined;
        const element = layer.textDivs[range.itemIndex];

        if (item?.str === undefined || element === undefined) {
            return { ok: false, failure: { reason: "content_mismatch", itemIndex: range.itemIndex } };
        }

        if (layer.textContentItemsStr[range.itemIndex] !== item.str) {
            return { ok: false, failure: { reason: "content_mismatch", itemIndex: range.itemIndex } };
        }

        // Items whose string was empty get an element PDF.js never inserts into the DOM. They
        // carry no visible text, so highlighting them would be a silent no-op.
        if (!element.isConnected) continue;

        const characters = [...item.str];
        const startOffset = range.wholeItem ? 0 : Math.max(0, Math.min(range.startOffset, characters.length));
        const endOffset = range.wholeItem ? characters.length : Math.max(startOffset, Math.min(range.endOffset, characters.length));

        if (startOffset === endOffset && !range.wholeItem) continue;

        targets.push({ element, text: item.str, startOffset, endOffset, wholeItem: range.wholeItem });
    }

    return { ok: true, targets };
};

/** What a single application of the highlight changed, so it can be undone exactly. */
export type AppliedHighlight = { element: HTMLElement; originalText: string | null };

/**
 * Marks the resolved characters.
 *
 * A range covering the whole item only needs a class. A narrower one has to split the element's
 * text into three parts and wrap the middle, which is how PDF.js's own find highlighter works —
 * without it, two occurrences inside one item would be indistinguishable on screen.
 */
export const applyHighlight = (targets: readonly HighlightTarget[]): AppliedHighlight[] => {
    const applied: AppliedHighlight[] = [];

    for (const target of targets) {
        if (target.wholeItem) {
            target.element.classList.add(HIGHLIGHT_CLASS);
            applied.push({ element: target.element, originalText: null });
            continue;
        }

        const characters = [...target.text];
        const before = characters.slice(0, target.startOffset).join("");
        const middle = characters.slice(target.startOffset, target.endOffset).join("");
        const after = characters.slice(target.endOffset).join("");

        const mark = target.element.ownerDocument.createElement("span");
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = middle;

        target.element.replaceChildren(
            ...(before === "" ? [] : [target.element.ownerDocument.createTextNode(before)]),
            mark,
            ...(after === "" ? [] : [target.element.ownerDocument.createTextNode(after)]),
        );

        applied.push({ element: target.element, originalText: target.text });
    }

    return applied;
};

/** Undoes a previous application. Always called before applying the next one (spec §8). */
export const clearHighlight = (applied: readonly AppliedHighlight[]): void => {
    for (const entry of applied) {
        if (entry.originalText === null) {
            entry.element.classList.remove(HIGHLIGHT_CLASS);
            continue;
        }
        // Restores the element to the single text node PDF.js created, so a later re-layout and
        // the text layer's own selection behaviour are unaffected.
        entry.element.textContent = entry.originalText;
    }
};
