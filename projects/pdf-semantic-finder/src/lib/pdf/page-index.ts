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
import type { ExtractedLine } from "@/lib/types";

/** Marks a character that belongs to no item, such as the separator between two lines. */
const NO_ITEM = -1;

export type PageIndex = {
    pageNumber: number;
    /** The page's lines joined in reading order, used to build a readable preview of a match. */
    originalText: string;
    /** For each code point of `originalText`, the item that produced it, or `NO_ITEM`. */
    itemIndexByCharacter: number[];
    /** `originalText` after search normalization. */
    searchText: string;
    /** For each code point of `searchText`, its index in `[...originalText]`. */
    sourceIndex: number[];
};

export type PageMatch = {
    pageNumber: number;
    /** Items covered by the match, ascending — what the viewer highlights. */
    itemIndexes: number[];
    /** The matched text with a little of its surroundings, for the results list. */
    previewText: string;
    /** Start offset in the page's `searchText`, so two matches can be told apart. */
    searchStart: number;
};

/** Characters of context shown on either side of a match in the results list. */
const PREVIEW_MARGIN = 60;

export const buildPageIndex = (pageNumber: number, lines: readonly ExtractedLine[]): PageIndex => {
    const characters: string[] = [];
    const itemIndexByCharacter: number[] = [];

    lines.forEach((line, lineNumber) => {
        if (lineNumber > 0) {
            // A separator keeps two lines from fusing in the preview. Normalization drops it, which
            // is exactly what lets a query span the line break.
            characters.push("\n");
            itemIndexByCharacter.push(NO_ITEM);
        }

        const lineCharacters = [...line.text];
        // `pieces` records where each item landed in the line, so the lookup is a direct fill
        // rather than a second pass over the text.
        const owner = new Array<number>(lineCharacters.length).fill(NO_ITEM);

        for (const piece of line.pieces) {
            for (let offset = piece.start; offset < piece.end && offset < owner.length; offset += 1) {
                owner[offset] = piece.itemIndex;
            }
        }

        characters.push(...lineCharacters);
        itemIndexByCharacter.push(...owner);
    });

    const originalText = characters.join("");
    const { text: searchText, sourceIndex } = normalizeWithOffsets(originalText);

    return { pageNumber, originalText, itemIndexByCharacter, searchText, sourceIndex };
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
        const covered = new Set<number>();

        for (let offset = start; offset < end; offset += 1) {
            const owner = index.itemIndexByCharacter[index.sourceIndex[offset]];
            if (owner !== undefined && owner !== NO_ITEM) covered.add(owner);
        }

        const firstOriginal = index.sourceIndex[start];
        const lastOriginal = index.sourceIndex[end - 1];
        const previewStart = Math.max(0, firstOriginal - PREVIEW_MARGIN);
        const previewEnd = Math.min(originalCharacters.length, lastOriginal + 1 + PREVIEW_MARGIN);

        matches.push({
            pageNumber: index.pageNumber,
            itemIndexes: [...covered].sort((a, b) => a - b),
            previewText:
                (previewStart > 0 ? "…" : "") +
                originalCharacters.slice(previewStart, previewEnd).join("").replace(/\s+/gu, " ").trim() +
                (previewEnd < originalCharacters.length ? "…" : ""),
            searchStart: start,
        });

        from = end;
    }

    return matches;
};
