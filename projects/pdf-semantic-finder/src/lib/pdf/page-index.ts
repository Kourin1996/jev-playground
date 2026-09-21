/**
 * A searchable index of one page's text, independent of how that page was segmented.
 *
 * Segments are the unit meaning search evaluates; they are the wrong unit for exact search. A
 * phrase that straddles two segments, or the line break between them, exists in the document but
 * in neither segment, so a per-segment containment test misses it — deterministically, for text
 * that is plainly there.
 *
 * This module keeps the whole page as one string and remembers which text item produced every
 * character, so a match can be carried back to the items it covers. That is not the string
 * searching spec §8 prohibits: the offsets come from the extraction structure, never from the
 * rendered page.
 */
import { normalizeWithOffsets } from "@/lib/pdf/build-segments";
import type { ExtractedLine, TextRange } from "@/lib/types";

/** Marks a character that belongs to no item, such as the separator between two lines. */
const NO_ITEM = -1;

export type PageIndex = {
    pageNumber: number;
    /** The page's lines joined in reading order, used to build a readable preview of a match. */
    originalText: string;
    /** For each code point of `originalText`, the item that produced it, or `NO_ITEM`. */
    itemIndexByCharacter: number[];
    /** For each code point of `originalText`, its offset inside the item that produced it. */
    offsetInItem: number[];
    /** `originalText` after search normalization. */
    searchText: string;
    /** For each code point of `searchText`, the half-open range of `originalText` it folded from. */
    sourceStart: number[];
    sourceEnd: number[];
    /**
     * For each UTF-16 code *unit* of `searchText`, the index of the code point it belongs to.
     *
     * Everything else in this module is indexed by code point, because a `TextRange` offset has to
     * survive a surrogate pair. `String.prototype.indexOf` does not play along: it returns a
     * code-unit offset, and `.length` counts code units. Feeding one of those straight into
     * `sourceStart` read the wrong entry for every match after the first supplementary character
     * on the page — a wrong highlight, or, when the index ran past the end, a result with no range
     * and an empty preview for text the document plainly contained.
     *
     * Built once with the rest of the index rather than per match: converting by slicing the
     * prefix for each hit would make a frequent query quadratic in the page.
     */
    codePointIndexByUnit: number[];
};

export type PageMatch = {
    pageNumber: number;
    /** Exactly the characters matched, so two occurrences in one item differ. */
    ranges: TextRange[];
    /** The matched text with a little of its surroundings, for the results list. */
    previewText: string;
    /** Code-point offset in the page's `searchText`, so two matches can be told apart. */
    searchStart: number;
};

/** Characters of context shown on either side of a match in the results list. */
const PREVIEW_MARGIN = 60;

export const buildPageIndex = (pageNumber: number, lines: readonly ExtractedLine[]): PageIndex => {
    const characters: string[] = [];
    const itemIndexByCharacter: number[] = [];
    const offsetInItem: number[] = [];

    lines.forEach((line, lineNumber) => {
        if (lineNumber > 0) {
            // A separator keeps two lines from fusing in the preview. Normalization drops it, which
            // is exactly what lets a query span the line break.
            characters.push("\n");
            itemIndexByCharacter.push(NO_ITEM);
            offsetInItem.push(0);
        }

        const lineCharacters = [...line.text];
        // `pieces` records where each item landed in the line, so the lookup is a direct fill
        // rather than a second pass over the text.
        const owner = new Array<number>(lineCharacters.length).fill(NO_ITEM);
        const within = new Array<number>(lineCharacters.length).fill(0);

        for (const piece of line.pieces) {
            for (let offset = piece.start; offset < piece.end && offset < owner.length; offset += 1) {
                owner[offset] = piece.itemIndex;
                within[offset] = offset - piece.start;
            }
        }

        characters.push(...lineCharacters);
        itemIndexByCharacter.push(...owner);
        offsetInItem.push(...within);
    });

    const originalText = characters.join("");
    const { text: searchText, sourceStart, sourceEnd } = normalizeWithOffsets(originalText);

    return {
        pageNumber,
        originalText,
        itemIndexByCharacter,
        offsetInItem,
        searchText,
        sourceStart,
        sourceEnd,
        codePointIndexByUnit: mapUnitsToCodePoints(searchText),
    };
};

/** One entry per UTF-16 code unit; a surrogate pair contributes its code-point index twice. */
const mapUnitsToCodePoints = (text: string): number[] => {
    const byUnit: number[] = [];
    let codePoint = 0;

    for (const character of text) {
        for (let unit = 0; unit < character.length; unit += 1) byUnit.push(codePoint);
        codePoint += 1;
    }

    return byUnit;
};

export const buildPageIndexes = (pages: readonly { pageNumber: number; lines: ExtractedLine[] }[]): PageIndex[] =>
    pages.map((page) => buildPageIndex(page.pageNumber, page.lines));

/**
 * Finds every occurrence of an already-normalized query on one page.
 *
 * Occurrences are found in the page's continuous text, so a phrase crossing a segment boundary or
 * a line break is found. A phrase crossing a *page* boundary is not: pages are indexed separately,
 * and the reading order between them is not something this PoC establishes.
 */
export const findMatchesOnPage = (index: PageIndex, normalizedQuery: string): PageMatch[] => {
    if (normalizedQuery === "") return [];

    const matches: PageMatch[] = [];
    const originalCharacters = [...index.originalText];

    // Overlapping occurrences are not reported separately; the next search starts after this one.
    for (let from = 0; from <= index.searchText.length - normalizedQuery.length;) {
        const start = index.searchText.indexOf(normalizedQuery, from);
        if (start === -1) break;

        const end = start + normalizedQuery.length;

        // Back into code points before touching either offset array. `indexOf` and `.length` deal
        // in UTF-16 units; every index in this module is a code point.
        const firstMatched = index.codePointIndexByUnit[start];
        const lastMatched = index.codePointIndexByUnit[end - 1];

        // The matched characters, in source order, grouped into one range per item. Keeping the
        // offsets is what lets two occurrences inside a single item highlight differently.
        const firstOriginal = index.sourceStart[firstMatched];
        const lastOriginal = index.sourceEnd[lastMatched];
        const ranges: TextRange[] = [];

        for (let offset = firstOriginal; offset < lastOriginal; offset += 1) {
            const itemIndex = index.itemIndexByCharacter[offset];
            if (itemIndex === undefined || itemIndex === NO_ITEM) continue;

            const within = index.offsetInItem[offset];
            const last = ranges.at(-1);

            if (last !== undefined && last.itemIndex === itemIndex && last.endOffset === within) {
                last.endOffset = within + 1;
                continue;
            }

            ranges.push({ itemIndex, startOffset: within, endOffset: within + 1, wholeItem: false });
        }

        const previewStart = Math.max(0, firstOriginal - PREVIEW_MARGIN);
        const previewEnd = Math.min(originalCharacters.length, lastOriginal + PREVIEW_MARGIN);

        matches.push({
            pageNumber: index.pageNumber,
            ranges,
            previewText:
                (previewStart > 0 ? "…" : "") +
                originalCharacters.slice(previewStart, previewEnd).join("").replace(/\s+/gu, " ").trim() +
                (previewEnd < originalCharacters.length ? "…" : ""),
            searchStart: firstMatched,
        });

        from = end;
    }

    return matches;
};
