/**
 * Synthetic PDF.js text items for segmentation tests.
 *
 * Segmentation takes plain line structures and imports nothing from `pdfjs-dist`, so it can be
 * exercised entirely with hand-written items. The three fictional fixture PDFs are for the
 * viewer specification and the evaluation harness, not for these tests.
 */
import type { TextItemLike } from "@/lib/types";

export type LineOptions = {
    y: number;
    text: string;
    fontSize?: number;
    x?: number;
    hasEOL?: boolean;
};

/** Advance width per character, as a multiple of the font size. Full width for CJK. */
const advanceOf = (text: string, fontSize: number): number => [...text].length * fontSize * 0.95;

/** One line as a single text item. */
export const line = ({ y, text, fontSize = 10.5, x = 72, hasEOL = true }: LineOptions): TextItemLike => ({
    str: text,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width: advanceOf(text, fontSize),
    height: fontSize,
    hasEOL,
});

/**
 * One line split across several items, the way a producer splits a run at every kerning change.
 * Items advance with no extra gap, so no separating space should be introduced.
 */
export const splitLine = (options: LineOptions, parts: number): TextItemLike[] => {
    const { y, text, fontSize = 10.5, x = 72, hasEOL = true } = options;
    const characters = [...text];
    const perPart = Math.ceil(characters.length / parts);
    const items: TextItemLike[] = [];
    let cursor = x;

    for (let index = 0; index < characters.length; index += perPart) {
        const chunk = characters.slice(index, index + perPart).join("");
        const width = advanceOf(chunk, fontSize);
        const isLast = index + perPart >= characters.length;

        items.push({
            str: chunk,
            transform: [fontSize, 0, 0, fontSize, cursor, y],
            width,
            height: fontSize,
            hasEOL: isLast ? hasEOL : false,
        });

        cursor += width;
    }

    return items;
};

/** A block of lines at a fixed pitch, starting at `startY` and running down the page. */
export const block = (startY: number, texts: string[], options: { pitch?: number; fontSize?: number } = {}): TextItemLike[] => {
    const { pitch = 16, fontSize = 10.5 } = options;
    return texts.map((text, index) => line({ y: startY - index * pitch, text, fontSize }));
};
