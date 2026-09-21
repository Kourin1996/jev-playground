/** Shared helpers for the unit tests. */

export { LIMITS, THRESHOLDS } from "@/lib/types";

/** Segment ID formatter, duplicated here so the tests do not depend on the browser modules. */
export const formatSegmentIdFallback = (pageNumber: number, sequence: number): string =>
    `p${String(pageNumber).padStart(3, "0")}-s${String(sequence).padStart(3, "0")}`;

/**
 * The characters a hit's ranges actually cover, read back out of the page index.
 *
 * A `TextRange` offset is relative to its **text item**, not to the page, so slicing the page text
 * by those offsets happens to agree only when every line is a single item starting at zero. Going
 * through `itemIndexByCharacter` and `offsetInItem` is what the highlight itself does, so a test
 * built on it fails for the same reasons the viewer would.
 */
export const coveredText = (
    index: { originalText: string; itemIndexByCharacter: number[]; offsetInItem: number[] },
    ranges: readonly { itemIndex: number; startOffset: number; endOffset: number }[],
): string => {
    const characters = [...index.originalText];
    let covered = "";

    for (const range of ranges) {
        for (let position = 0; position < characters.length; position += 1) {
            if (index.itemIndexByCharacter[position] !== range.itemIndex) continue;
            const within = index.offsetInItem[position];
            if (within >= range.startOffset && within < range.endOffset) covered += characters[position];
        }
    }

    return covered;
};
