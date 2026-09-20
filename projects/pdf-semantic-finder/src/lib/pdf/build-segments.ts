/**
 * Segmentation heuristics (spec §5.2) and the deterministic search normalization (spec §6.1).
 *
 * These are PoC heuristics, not a promise of correct reading order for arbitrary PDFs.
 *
 * The module takes plain line structures rather than PDF.js objects and imports nothing from
 * `pdfjs-dist`, so the whole of it can be exercised with hand-written items and no PDF.
 */
import type { ExtractedLine, PdfSegment } from "@/lib/types";
import { LIMITS, countCharacters } from "@/lib/types";

/** A line gap wider than this multiple of the page's typical line pitch is a paragraph boundary. */
const PARAGRAPH_GAP_RATIO = 1.6;

/** A line set this much larger than the page's body size reads as a heading. */
const HEADING_FONT_RATIO = 1.15;

/** Lines that open a list item, a numbered clause, or a 条/項 start a new segment. */
const LIST_ITEM_PATTERN = /^\s*(?:[-–—•·*・･]|[（(]\s*[0-9０-９]+\s*[）)]|[0-9０-９]+\s*[.)．）、]|第\s*[0-9０-９一二三四五六七八九十百]+\s*[条項号章]|[①-⑳])/u;

/** A line with no sentence-ending punctuation reads as a heading when it is also short. */
const SENTENCE_END_PATTERN = /[。．.!?！？]\s*$/u;

/**
 * Continuations such as "however" qualify the text before them, so a segment is never closed
 * immediately before one while the combined length still fits (spec §5.2).
 */
const CONTINUATION_PATTERN = /^\s*(?:ただし|但し|なお|もっとも|この場合|その場合|however|provided that|except that|unless)/iu;

const SENTENCE_BREAK_PATTERN = /[。．.！？!?]/u;

const CJK_BOUNDARY = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}　-〿＀-￯]/u;

const ZERO_WIDTH_CHARACTER = /[\u200B-\u200D\u2060\uFEFF]/u;
const WHITESPACE_CHARACTER = /\s/u;

/**
 * Normalizes text for exact search. Applied identically to the query and to every segment, so
 * matching is deterministic and symmetric.
 *
 * Whitespace is removed rather than collapsed. Japanese is written without word spaces, and
 * extraction still inserts spurious ones when a font changes mid-word, so 返 金 must match a query
 * for 返金. The cost is that an English query for "the cat" would also match "thecat"; that is
 * accepted deliberately for a Japanese-first PoC.
 *
 * NFKC does the real folding here — PDF.js's own normalization only touches ligatures and exotic
 * spaces, and leaves fullwidth ASCII and halfwidth katakana alone. Note that NFKC also folds ① to
 * 1, so an exact search for 1 matches ①.
 */
export const normalizeForSearch = (text: string): string => normalizeWithOffsets(text).text;

/** Normalized text alongside, for every character of it, the source code-point index it came from. */
export type NormalizedText = {
    text: string;
    /** `sourceIndex[i]` is the index into `[...input]` that produced `text[i]`. */
    sourceIndex: number[];
};

/**
 * The single definition of search normalization, carrying offsets back to the input.
 *
 * Folding is applied per code point rather than over the whole string, which is what makes the
 * offsets exact — a whole-string pass cannot say which input character produced which output one.
 * Two rare differences from whole-string folding follow, and are accepted deliberately: a
 * decomposed sequence such as か + ゙ no longer composes into が, and a Greek final sigma no longer
 * depends on its neighbours. Neither occurs in the documents this PoC targets, and a test pins the
 * two forms against each other over the fuzz corpus.
 */
export const normalizeWithOffsets = (text: string): NormalizedText => {
    const characters = [...text];
    const out: string[] = [];
    const sourceIndex: number[] = [];

    characters.forEach((character, index) => {
        // NFKC is what folds fullwidth ASCII, halfwidth katakana, Kangxi radicals and ① alike.
        for (const piece of character.normalize("NFKC").toLowerCase()) {
            if (ZERO_WIDTH_CHARACTER.test(piece)) continue;
            // Removed rather than collapsed: extraction inserts spurious spaces mid-word, so 返 金
            // has to match a query for 返金. A line break between two words disappears for the same
            // reason, which is what lets a query span one.
            if (WHITESPACE_CHARACTER.test(piece)) continue;

            out.push(piece);
            sourceIndex.push(index);
        }
    });

    return { text: out.join(""), sourceIndex };
};

/**
 * Collapses runs of whitespace introduced by item-level extraction. Presentation only: the wording
 * is never rewritten (spec §5.3).
 */
const tidyOriginalText = (text: string): string => text.replace(/[ \t ]+/gu, " ").trim();

export const formatSegmentId = (pageNumber: number, sequence: number): string =>
    `p${String(pageNumber).padStart(3, "0")}-s${String(sequence).padStart(3, "0")}`;

export type SegmentationPage = {
    pageNumber: number;
    lines: ExtractedLine[];
};

const medianOf = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Joins reconstructed lines back into running text.
 *
 * A line break inside a Japanese paragraph is layout, not a word boundary, so no space is
 * inserted where either side of the break is CJK.
 */
const joinLines = (lines: readonly ExtractedLine[]): string => {
    let text = "";

    for (const line of lines) {
        if (text === "") {
            text = line.text;
            continue;
        }

        const previousCharacter = text.at(-1);
        const nextCharacter = line.text.at(0);
        const needsSpace =
            previousCharacter !== undefined &&
            nextCharacter !== undefined &&
            !/\s/u.test(previousCharacter) &&
            !/\s/u.test(nextCharacter) &&
            !CJK_BOUNDARY.test(previousCharacter) &&
            !CJK_BOUNDARY.test(nextCharacter);

        text += needsSpace ? ` ${line.text}` : line.text;
    }

    return text;
};

/**
 * Splits a line that exceeds the hard maximum on its own.
 *
 * The split happens at item boundaries wherever possible, so each resulting line maps to exactly
 * the items whose characters it contains. Splitting the text alone would leave every part claiming
 * the whole line, and selecting any one of them would highlight all of them.
 *
 * A single item longer than the maximum cannot be subdivided any further — the PDF offers no
 * finer position than that one item — so its parts necessarily share that index. That is the one
 * case where a highlight is wider than its segment, and it takes a single text item of more than
 * 800 characters to reach it.
 */
export const splitLongLine = (line: ExtractedLine): ExtractedLine[] => {
    const characters = [...line.text];
    if (characters.length <= LIMITS.maxSegmentCharacters) return [line];

    const parts: ExtractedLine[] = [];
    let cursor = 0;

    while (cursor < characters.length) {
        const limit = Math.min(cursor + LIMITS.maxSegmentCharacters, characters.length);
        const window = characters.slice(cursor, limit);

        // Prefer a sentence end, then an item boundary, before cutting mid-item.
        const sentenceEnd = window.findLastIndex((character) => SENTENCE_BREAK_PATTERN.test(character));
        const itemBoundary = line.pieces
            .map((piece) => piece.end - cursor)
            .filter((offset) => offset > 0 && offset <= window.length)
            .at(-1);

        let cut = window.length;
        if (limit < characters.length) {
            if (sentenceEnd > 0) cut = sentenceEnd + 1;
            else if (itemBoundary !== undefined && itemBoundary > 0) cut = itemBoundary;
        }

        const start = cursor;
        const end = cursor + cut;

        parts.push({
            text: characters.slice(start, end).join(""),
            // Offsets are rebased onto the part, and only the items this part overlaps are kept.
            pieces: line.pieces
                .filter((piece) => piece.start < end && piece.end > start)
                .map((piece) => ({
                    itemIndex: piece.itemIndex,
                    start: Math.max(0, piece.start - start),
                    end: Math.min(end, piece.end) - start,
                })),
            itemIndexes: line.pieces
                .filter((piece) => piece.start < end && piece.end > start)
                .map((piece) => piece.itemIndex)
                .sort((a, b) => a - b),
            x: line.x,
            y: line.y,
            fontSize: line.fontSize,
        });

        cursor = end;
    }

    return parts;
};

/**
 * Groups one page's lines into segments.
 *
 * This packs rather than splits: lines accumulate until the minimum length is reached, and only
 * then is the next boundary candidate honored. Splitting at every boundary instead would emit one
 * segment per 項 and blow the 80-segment cap on an ordinary contract that uses barely two thirds
 * of the character budget.
 *
 * Every segment stays within its physical page, so page boundaries are always a hard split.
 */
const segmentPage = (page: SegmentationPage): ExtractedLine[][] => {
    const lines = page.lines.filter((line) => line.text.trim() !== "").flatMap(splitLongLine);
    if (lines.length === 0) return [];

    const gaps = lines.slice(1).map((line, index) => Math.max(0, lines[index].y - line.y));
    const typicalGap = medianOf(gaps);
    const bodyFontSize = medianOf(lines.map((line) => line.fontSize));
    const typicalLength = medianOf(lines.map((line) => countCharacters(line.text)));

    const groups: ExtractedLine[][] = [];
    let currentGroup: ExtractedLine[] = [];
    let currentLength = 0;

    const flush = () => {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
    };

    lines.forEach((line, index) => {
        const lineLength = countCharacters(line.text);
        const previous = index > 0 ? lines[index - 1] : null;
        const gap = previous === null ? 0 : Math.max(0, previous.y - line.y);

        const hasParagraphGap = typicalGap > 0 && gap > typicalGap * PARAGRAPH_GAP_RATIO;
        const isHeading =
            (bodyFontSize > 0 && line.fontSize > bodyFontSize * HEADING_FONT_RATIO) ||
            (typicalLength > 0 && lineLength < typicalLength * 0.6 && !SENTENCE_END_PATTERN.test(line.text));
        const isBoundaryCandidate = hasParagraphGap || isHeading || LIST_ITEM_PATTERN.test(line.text);

        // A continuation clause qualifies what precedes it, so it suppresses the boundary unless
        // keeping it would breach the hard limit.
        const isContinuation = CONTINUATION_PATTERN.test(line.text);
        const wouldExceedHardLimit = currentLength + lineLength > LIMITS.maxSegmentCharacters;
        const reachedMinimum = currentLength >= LIMITS.minSegmentCharacters;

        const shouldBreak =
            currentGroup.length > 0 &&
            (wouldExceedHardLimit || (reachedMinimum && isBoundaryCandidate && !isContinuation) || currentLength >= LIMITS.softMaxSegmentCharacters);

        if (shouldBreak) flush();

        currentGroup.push(line);
        currentLength += lineLength;
    });

    flush();

    return groups;
};

/**
 * Builds the searchable segments for a whole document.
 *
 * Segment IDs are assigned per page in reading order, so they are stable for a given extraction
 * and distinguish repeated text by position rather than by content.
 */
export const buildSegments = (pages: readonly SegmentationPage[]): PdfSegment[] => {
    const segments: PdfSegment[] = [];

    for (const page of pages) {
        const groups = segmentPage(page);
        const groupTexts = groups.map((group) => tidyOriginalText(joinLines(group)));
        let sequence = 0;

        groups.forEach((group, groupIndex) => {
            const originalText = groupTexts[groupIndex];
            if (originalText === "") return;

            sequence += 1;

            segments.push({
                id: formatSegmentId(page.pageNumber, sequence),
                pageNumber: page.pageNumber,
                originalText,
                searchText: normalizeForSearch(originalText),
                itemIndexes: [...new Set(group.flatMap((line) => line.itemIndexes))].sort((a, b) => a - b),
                contextBefore: groupTexts[groupIndex - 1],
                contextAfter: groupTexts[groupIndex + 1],
            });
        });
    }

    return segments;
};
