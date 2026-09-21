/**
 * Segmentation heuristics (spec §5.2) and the deterministic search normalization (spec §6.1).
 *
 * These are PoC heuristics, not a promise of correct reading order for arbitrary PDFs.
 *
 * The module takes plain line structures rather than PDF.js objects and imports nothing from
 * `pdfjs-dist`, so the whole of it can be exercised with hand-written items and no PDF.
 */
import type { ExtractedLine, PdfSegment, TextRange } from "@/lib/types";
import { LIMITS, countCharacters } from "@/lib/types";

/** A line gap wider than this multiple of the page's typical line pitch is a paragraph boundary. */
const PARAGRAPH_GAP_RATIO = 1.6;

/** A line set this much larger than the page's body size reads as a heading. */
const HEADING_FONT_RATIO = 1.15;

/** Lines that open a list item, a numbered clause, or a 条/項 start a new segment. */
const LIST_ITEM_PATTERN = /^\s*(?:[-–—•·*・･]|[（(]\s*[0-9０-９]+\s*[）)]|[0-9０-９]+\s*[.)．）、]|第\s*[0-9０-９一二三四五六七八九十百]+\s*[条項号章]|[①-⑳])/u;

/**
 * Numbering that marks a **provision** rather than a heading.
 *
 * A group that opens with one of these is a passage in its own right and is never merged into a
 * neighbour, however short it is and whether or not it ends a sentence. That is the signal three
 * previous rules stood in for and got wrong: a 250-character floor, then a 40-character one, then
 * sentence-ending punctuation. Each merged `第5条　返金不可` — a complete provision — into the
 * clause beside it, because each was one heuristic doing the work of "is this a provision".
 *
 * `章` and a bare Latin `N.` are deliberately absent. They mark headings at least as often as
 * provisions (`第2章 利用条件`, `4. Proof-of-Work`), and a heading belongs with the text it
 * introduces. This is a Japanese-first PoC, where 条/項/号 and （N）/① do mark a provision
 * unambiguously; the cost is that a Latin numbered clause too short to end a sentence would still
 * be merged. See the §5.2 deviation in docs/spec.md.
 */
const PROVISION_OPENER = /^\s*(?:[-–—•·*・･]|[（(]\s*[0-9０-９]+\s*[）)]|第\s*[0-9０-９一二三四五六七八九十百]+\s*[条項号]|[①-⑳])/u;

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
 * Normalizes text for exact search. Applied identically to the query and to every passage, so
 * matching is deterministic and symmetric.
 *
 * Whitespace is removed rather than collapsed. Japanese is written without word spaces, and
 * extraction still inserts spurious ones when a font changes mid-word, so 返 金 must match a query
 * for 返金. A line break disappears for the same reason, which is what lets a query span one. The
 * cost is that an English query for "the cat" would also match "thecat"; that is accepted
 * deliberately for a Japanese-first PoC.
 *
 * NFKC does the real folding — PDF.js's own normalization only touches ligatures and exotic spaces,
 * and leaves fullwidth ASCII and halfwidth katakana alone. Note that NFKC also folds ① to 1, so an
 * exact search for 1 matches ①.
 */
export const normalizeForSearch = (text: string): string => normalizeWithOffsets(text).text;

/** Normalized text alongside, for each of its characters, the source range it was folded from. */
export type NormalizedText = {
    text: string;
    /** `sourceStart[i]` is the first index into `[...input]` that produced `text[i]`. */
    sourceStart: number[];
    /** `sourceEnd[i]` is one past the last such index. */
    sourceEnd: number[];
};

/**
 * Marks that fold into the character before them.
 *
 * Halfwidth katakana carries its dakuten as a separate code point (`ｶ` + `ﾞ`), and NFKC only
 * composes them into `ガ` when it sees them together. The same holds for the combining marks a
 * decomposed `が` is written with.
 */
const COMBINING_MARK = /[\u3099\u309A\uFF9E\uFF9F]/u;

/** True for a character that is dropped before anything else looks at the text. */
const isDiscarded = (character: string): boolean => ZERO_WIDTH_CHARACTER.test(character) || WHITESPACE_CHARACTER.test(character);

/**
 * The single definition of search normalization, carrying offsets back to the input.
 *
 * Three steps, and the order of the first two is the whole point:
 *
 * 1. **Discard** whitespace and zero-width characters, remembering where each survivor came from.
 * 2. **Cluster** the survivors — a base character plus any marks that compose with it.
 * 3. **Fold** each cluster with NFKC, dropping any whitespace the fold itself produced.
 *
 * Folding runs over clusters rather than over the whole string because a whole-string pass cannot
 * say which input character produced which output one, and the offsets are what let a match be
 * carried back to its text items. A cluster can produce several characters, or one character from
 * several inputs, so each output character records a source *range* rather than a single index.
 *
 * Two earlier versions of this were wrong, in the same place and for the same reason — a cluster
 * was built from whatever sat immediately next in the input:
 *
 * - Folding one code point at a time meant `ｶ` and `ﾞ` folded separately to `カ` plus a combining
 *   mark, which never equals the `ガ` a query produces.
 * - Clustering before discarding meant anything *between* the base and its mark broke the fold, so
 *   `ｶ` + space + `ﾞ` still missed `ガ`. Extraction inserts exactly such spaces when a font changes
 *   mid-word, and a line break lands there too, so this is ordinary text rather than a corner case.
 *
 * Both were silent failures to match real Japanese. Discarding first is what makes a mark find its
 * base whatever separated them in the PDF. `tests/segment.test.ts` pins the specific pairs, because
 * a comparison against a second implementation only catches a bug the two do not share.
 */
export const normalizeWithOffsets = (text: string): NormalizedText => {
    const characters = [...text];

    // Survivors, each remembering where it came from. Discarded characters leave no output, but
    // they stay inside the source range of the cluster that spans them.
    const kept: Array<{ character: string; sourceIndex: number }> = [];
    for (let index = 0; index < characters.length; index += 1) {
        if (!isDiscarded(characters[index])) kept.push({ character: characters[index], sourceIndex: index });
    }

    const out: string[] = [];
    const sourceStart: number[] = [];
    const sourceEnd: number[] = [];

    for (let index = 0; index < kept.length; index += 1) {
        let end = index + 1;
        while (end < kept.length && COMBINING_MARK.test(kept[end].character)) end += 1;

        const cluster = kept
            .slice(index, end)
            .map((entry) => entry.character)
            .join("");

        for (const piece of cluster.normalize("NFKC").toLowerCase()) {
            // NFKC can produce a space of its own, from a compatibility character that decomposes
            // to one. Dropping it here keeps the "no whitespace" guarantee whole.
            if (isDiscarded(piece)) continue;

            out.push(piece);
            sourceStart.push(kept[index].sourceIndex);
            sourceEnd.push(kept[end - 1].sourceIndex + 1);
        }

        index = end - 1;
    }

    return { text: out.join(""), sourceStart, sourceEnd };
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
 * Median over *characters* rather than over lines: a line counts as much as the text it carries.
 *
 * Both page statistics below describe "the body", and a plain median only says that when body
 * lines are in the majority — which a page with a figure breaks. On page 2 of the Bitcoin
 * whitepaper the diagram's labels (`Hash`, `Verify`, `Sign`, `Owner 1's`) outnumber the prose
 * lines, so the median font size came out as the label font, 8.65 against the body's 10.09. Every
 * line of prose was then larger than "the body size" and read as a heading, so the boundary rule
 * fired on every one of them: twenty consecutive segments, each a single line, each cut
 * mid-sentence. The same happened on page 8 among the references.
 *
 * Weighting by character count makes a 90-character line outweigh a four-character label, which is
 * what "the size most of this page's text is set in" was supposed to mean all along.
 */
const characterWeightedMedian = (samples: readonly { value: number; weight: number }[]): number => {
    const usable = samples.filter((sample) => sample.weight > 0);
    if (usable.length === 0) return 0;

    const sorted = [...usable].sort((a, b) => a.value - b.value);
    const half = sorted.reduce((total, sample) => total + sample.weight, 0) / 2;

    let seen = 0;
    for (const sample of sorted) {
        seen += sample.weight;
        if (seen >= half) return sample.value;
    }

    return sorted[sorted.length - 1].value;
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
                    // How far into the item this part begins. Non-zero exactly when the cut fell
                    // inside the item, which is the case that makes several parts share an index.
                    itemOffset: piece.itemOffset + Math.max(0, start - piece.start),
                    itemLength: piece.itemLength,
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
 * Groups one page's lines into segments — the search units of spec §5.2.
 *
 * A segment plays three distinct roles, and only the first shapes this function:
 *
 * - **search unit** — what a result points at, and what the reader is shown. Cut at natural
 *   boundaries (a 条/項 opener, a list marker, a heading, a paragraph gap) so a unit is one claim.
 * - **evaluation context** — the neighbouring units, sent alongside so a pronoun or a "the
 *   foregoing" resolves. Attached in `buildSegments`, never merged into the unit itself.
 * - **evidence range** — the items the highlight covers, carried by `itemIndexes`.
 *
 * Earlier this packed lines until a 250-character average was reached before honoring any
 * boundary, which merged clauses to hit a capacity number: a question answered by one sentence
 * came back as three articles. The only remaining length rules are the hard cap, the soft cut for
 * a paragraph that never offers a boundary, and a merge of fragments too small to be a passage.
 *
 * Every segment stays within its physical page, so page boundaries are always a hard split.
 */
const segmentPage = (page: SegmentationPage): ExtractedLine[][] => {
    const lines = page.lines.filter((line) => line.text.trim() !== "").flatMap(splitLongLine);
    if (lines.length === 0) return [];

    const gaps = lines.slice(1).map((line, index) => Math.max(0, lines[index].y - line.y));
    const typicalGap = medianOf(gaps);
    // Both describe the body text, so both are weighted by how much text each line carries. See
    // `characterWeightedMedian` for the page this was measured on.
    const weights = lines.map((line) => ({ line, weight: countCharacters(line.text) }));
    const bodyFontSize = characterWeightedMedian(weights.map(({ line, weight }) => ({ value: line.fontSize, weight })));
    const typicalLength = characterWeightedMedian(weights.map(({ weight }) => ({ value: weight, weight })));

    const groups: ExtractedLine[][] = [];
    let currentGroup: ExtractedLine[] = [];
    let currentLength = 0;

    const flush = () => {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
    };

    /**
     * Closes the group after the last line that finishes a sentence, carrying the rest forward.
     *
     * The hard maximum has to fall somewhere, but it does not have to fall mid-sentence. A
     * paragraph longer than 800 characters — the whitepaper's abstract, for one — used to be cut
     * at whichever line crossed the limit, so the passage ended in the middle of a clause and the
     * next one began with its other half. Cutting back to the last full stop gives the reader a
     * unit that reads, and hands the trailing lines to the next one.
     *
     * When no line in the group finishes a sentence there is nothing to cut back to, and the whole
     * group is closed as before.
     */
    const flushAtLastSentence = () => {
        const lastSentenceEnd = currentGroup.findLastIndex((line) => SENTENCE_END_PATTERN.test(line.text));
        if (lastSentenceEnd < 0 || lastSentenceEnd === currentGroup.length - 1) {
            flush();
            return;
        }

        groups.push(currentGroup.slice(0, lastSentenceEnd + 1));
        currentGroup = currentGroup.slice(lastSentenceEnd + 1);
        currentLength = currentGroup.reduce((total, line) => total + countCharacters(line.text), 0);
    };

    lines.forEach((line, index) => {
        const lineLength = countCharacters(line.text);
        const previous = index > 0 ? lines[index - 1] : null;
        const gap = previous === null ? 0 : Math.max(0, previous.y - line.y);

        // A change of column is a hard boundary, like a page break: the last line of one column and
        // the first of the next are adjacent in reading order and belong to different passages.
        const changedColumn = previous !== null && (previous.column ?? 0) !== (line.column ?? 0);

        const hasParagraphGap = typicalGap > 0 && gap > typicalGap * PARAGRAPH_GAP_RATIO;
        const isHeading =
            (bodyFontSize > 0 && line.fontSize > bodyFontSize * HEADING_FONT_RATIO) ||
            (typicalLength > 0 && lineLength < typicalLength * 0.6 && !SENTENCE_END_PATTERN.test(line.text));
        const isBoundaryCandidate = hasParagraphGap || isHeading || LIST_ITEM_PATTERN.test(line.text);

        // A continuation clause qualifies what precedes it, so it suppresses the boundary unless
        // keeping it would breach the hard limit.
        const isContinuation = CONTINUATION_PATTERN.test(line.text);
        const wouldExceedHardLimit = currentLength + lineLength > LIMITS.maxSegmentCharacters;

        /*
         * The soft cut says "close at the next opportunity", and a line boundary is not one. Lines
         * in justified prose end wherever the measure runs out, so cutting at the first line past
         * 450 characters halves a sentence — on the Bitcoin whitepaper it split "incrementing a
         * nonce in the | block until a value is found that gives the block's hash the required
         * zero bits", which is the whole of what a reader asking about the nonce needs.
         *
         * So the soft cut waits for a line that finishes a sentence. The hard maximum stays
         * absolute and can still land mid-sentence; nothing else can bound a paragraph that never
         * finishes one.
         */
        const previousLineEndsSentence = currentGroup.length > 0 && SENTENCE_END_PATTERN.test(currentGroup[currentGroup.length - 1].text);

        const shouldBreak =
            currentGroup.length > 0 &&
            (changedColumn ||
                wouldExceedHardLimit ||
                (isBoundaryCandidate && !isContinuation) ||
                (currentLength >= LIMITS.softMaxSegmentCharacters && previousLineEndsSentence));

        // The hard maximum is the only break that can land mid-sentence, so it is the only one
        // that cuts back; every other break is already at a boundary the text offered.
        if (shouldBreak) {
            if (wouldExceedHardLimit && !changedColumn) flushAtLastSentence();
            else flush();
        }

        currentGroup.push(line);
        currentLength += lineLength;
    });

    flush();

    return mergeFragments(groups);
};

/**
 * A group too small to be a passage, that belongs with the text **after** it.
 *
 * Length alone cannot tell a heading from a one-sentence 条, and using it as the deciding condition
 * put five independent clauses — `第4条　中途解約はできない。` and its neighbours, each a complete
 * sentence answering a different question — into a single search unit. That is the same failure the
 * 250-character floor was removed to end, just at a smaller number.
 *
 * What actually separates the two populations is sentence-ending punctuation. A heading, a bare
 * clause number, a figure label and a line of a formula carry none; a clause that answers something
 * ends in `。` however short it is. Length stays only as a second condition, so a long heading is
 * still a unit of its own rather than being glued to the text beneath it.
 */
const opensNextPassage = (text: string): boolean =>
    !PROVISION_OPENER.test(text) && !SENTENCE_END_PATTERN.test(text) && countCharacters(text) < LIMITS.minSegmentCharacters;

/**
 * A group too small to be a passage, that belongs with the text **before** it.
 *
 * The orphaned last line of a wrapped paragraph ends a sentence, so the rule above would let it
 * stand alone — the Bitcoin whitepaper produced a unit consisting of the single word `ownership.`
 * that way. It qualifies nothing on its own and its subject is in the lines before it.
 *
 * A numbered clause is excluded, because `第5条　返金は行わない。` is short and ends a sentence and
 * is nonetheless exactly the passage a reader is looking for.
 */
const closesPreviousPassage = (text: string): boolean =>
    !PROVISION_OPENER.test(text) && SENTENCE_END_PATTERN.test(text) && countCharacters(text) < LIMITS.minSegmentCharacters;

/**
 * Folds groups that are not passages into their neighbours, in whichever direction they belong.
 *
 * Forward fragments accumulate until the accumulated text stops being one, rather than merging in
 * pairs, or a run of short lines such as the reference list of a paper would still emit one unit
 * per line. A forward fragment at the end of a page has nothing ahead of it, so it attaches to what
 * came before instead.
 *
 * No merge ever breaches the hard cap: a fragment that cannot fit its neighbour stands on its own
 * rather than producing an over-length unit.
 */
const mergeFragments = (groups: ExtractedLine[][]): ExtractedLine[][] => {
    const textOf = (group: readonly ExtractedLine[]) => tidyOriginalText(joinLines(group));
    const lengthOf = (group: readonly ExtractedLine[]) => countCharacters(textOf(group));
    const merged: ExtractedLine[][] = [];
    let pending: ExtractedLine[] = [];

    const attachToPrevious = (group: ExtractedLine[]) => {
        const last = merged.at(-1);
        if (last !== undefined && lengthOf(last) + lengthOf(group) <= LIMITS.maxSegmentCharacters) last.push(...group);
        else merged.push(group);
    };

    for (const group of groups) {
        const text = textOf(group);

        if (pending.length === 0) {
            if (closesPreviousPassage(text)) attachToPrevious(group);
            else if (opensNextPassage(text)) pending = [...group];
            else merged.push(group);
            continue;
        }

        // The fragment cannot grow past the hard cap, so it is emitted as it stands instead.
        if (lengthOf(pending) + lengthOf(group) > LIMITS.maxSegmentCharacters) {
            merged.push(pending);
            pending = [];
            if (closesPreviousPassage(text)) attachToPrevious(group);
            else if (opensNextPassage(text)) pending = [...group];
            else merged.push(group);
            continue;
        }

        pending.push(...group);
        if (!opensNextPassage(textOf(pending))) {
            merged.push(pending);
            pending = [];
        }
    }

    if (pending.length > 0) attachToPrevious(pending);

    return merged;
};

/**
 * The exact characters a group of lines covers, as item ranges.
 *
 * A piece that covers its whole item is recorded as `wholeItem`, so the common case keeps the
 * highlight class on the text-layer element itself rather than rewriting its children — which
 * matters because a rewritten element is torn down and rebuilt on every zoom.
 *
 * Ranges that meet inside one item are joined, so a segment built from several lines of the same
 * item does not emit a range per line.
 */
const rangesOf = (group: readonly ExtractedLine[]): TextRange[] => {
    const ranges: TextRange[] = [];

    for (const line of group) {
        for (const piece of line.pieces) {
            const startOffset = piece.itemOffset;
            const endOffset = piece.itemOffset + (piece.end - piece.start);
            if (endOffset <= startOffset) continue;

            const previous = ranges.at(-1);
            if (previous !== undefined && previous.itemIndex === piece.itemIndex && previous.endOffset === startOffset) {
                previous.endOffset = endOffset;
                previous.wholeItem = previous.startOffset === 0 && endOffset === piece.itemLength;
                continue;
            }

            ranges.push({
                itemIndex: piece.itemIndex,
                startOffset,
                endOffset,
                wholeItem: startOffset === 0 && endOffset === piece.itemLength,
            });
        }
    }

    return ranges;
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
                ranges: rangesOf(group),
                contextBefore: groupTexts[groupIndex - 1],
                contextAfter: groupTexts[groupIndex + 1],
            });
        });
    }

    return segments;
};
