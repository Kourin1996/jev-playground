/**
 * PDF loading and text extraction (spec §5.1).
 *
 * Text items are positioning primitives rather than paragraphs, so this module groups them into
 * lines while keeping every original PDF.js text-item index. Filtering or joining must never
 * change the indexes used later to locate rendered text.
 *
 * This is the only module that talks to PDF.js during extraction; the segmentation heuristics in
 * `build-segments.ts` work on the plain line structures produced here.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { ExtractedLine, LinePiece, TextItemLike } from "@/lib/types";

// Imported rather than copied, so the worker can never drift from the library version.
GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * Runtime assets are copied from the installed `pdfjs-dist` by `scripts/copy-pdfjs-assets.mjs`.
 *
 * The CMaps are what make Japanese PDFs extractable at all: a PDF using a predefined CID encoding
 * such as `90ms-RKSJ-H` or `UniJIS-UCS2-H` yields empty or unusable text without them. PDF.js
 * rejects any of these URLs that does not end in a slash.
 */
const ASSET_URLS = {
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
} as const;

/**
 * `getTextContent` options used for every page.
 *
 * `includeMarkedContent: false` keeps `items` free of marked-content markers, which is what makes
 * `TextLayer.textDivs[i]` line up one-to-one with `items[i]` (see `highlight.ts`). PDF.js's own
 * normalization is left enabled: it only folds ligatures and exotic spaces such as NBSP, and the
 * real case and width folding happens in `normalizeForSearch`.
 */
const TEXT_CONTENT_OPTIONS = { includeMarkedContent: false } as const;

export type PageExtraction = {
    pageNumber: number;
    /**
     * Retained deliberately: the identical object is handed to `TextLayer` as `textContentSource`,
     * which is what guarantees the item-index to text-layer-element mapping.
     */
    textContent: TextContent;
    lines: ExtractedLine[];
    characterCount: number;
};

/**
 * A horizontal gap wider than this multiple of the page's body size ends a line.
 *
 * Grouping on baseline alone merges the columns of a two-column page into single sentences, which
 * are then sent to Jev as if the document said them. Splitting at the gutter keeps the text honest;
 * it does not fix the reading order between columns, which is why such pages are reported.
 */
const COLUMN_GAP_RATIO = 3;

export type PdfExtraction = {
    document: PDFDocumentProxy;
    /**
     * Releases the document and the PDF bytes held by the PDF.js worker.
     *
     * `PDFDocumentProxy.destroy()` was removed in PDF.js v6, so teardown goes through the loading
     * task. This is the hook the no-persistence requirement depends on.
     */
    destroy: () => Promise<void>;
    pageCount: number;
    pages: PageExtraction[];
    /** Physical page numbers that yielded no extractable text (spec §10). */
    pagesWithoutText: number[];
    /** Pages skipped because their rotation is not a supported layout (spec §2). */
    rotatedPages: number[];
    /** Pages whose text splits into side-by-side blocks, which spec §2 does not claim to support. */
    multiColumnPages: number[];
    totalCharacters: number;
};

const CJK_PATTERN = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}　-〿＀-￯]/u;

/** True for characters that are written without surrounding word spaces. */
export const isCjk = (character: string | undefined): boolean => character !== undefined && CJK_PATTERN.test(character);

/**
 * Glyph height derived from the text matrix.
 *
 * `item.height` comes from a different code path and is zero or degenerate for some Type 3 and
 * rotated runs, so the transform is the reliable source.
 */
export const fontSizeOf = (item: TextItemLike): number => {
    const fromTransform = Math.hypot(item.transform[2], item.transform[3]);
    return fromTransform > 0 ? fromTransform : item.height;
};

const medianOf = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Decides whether two adjacent items on the same line need a separating space.
 *
 * Japanese is written without inter-word spaces, so a horizontal gap between two CJK items is
 * ordinary letter spacing rather than a word break. Producers routinely split a run at every
 * kerning change, so a gap-only rule would turn 中途解約の場合 into 中 途 解 約 の 場 合 and
 * corrupt both the displayed passage and the text sent for evaluation.
 */
export const needsSeparatingSpace = (previous: TextItemLike, next: TextItemLike, gap: number): boolean => {
    const previousCharacter = previous.str.at(-1);
    const nextCharacter = next.str.at(0);

    if (previousCharacter === undefined || nextCharacter === undefined) return false;
    if (/\s/u.test(previousCharacter) || /\s/u.test(nextCharacter)) return false;
    if (isCjk(previousCharacter) || isCjk(nextCharacter)) return false;

    return gap > 0.25 * fontSizeOf(previous);
};

/**
 * Groups a page's text items into lines using baseline position and end-of-line markers.
 *
 * `hasEOL` is producer-dependent: some writers set it on nearly every item and some never set it,
 * so it is only trusted when a census of the page shows it carries information. Without that
 * check, a Word-exported Japanese PDF would emit one line per item.
 */
export const groupItemsIntoLines = (items: readonly TextItemLike[]): ExtractedLine[] => {
    type PendingLine = { entries: Array<{ item: TextItemLike; index: number }>; y: number; fontSize: number };

    const usable = items
        .map((item, index) => ({ item, index }))
        // Items with an empty string produce a text-layer element that PDF.js never inserts into
        // the DOM, so they can carry no highlight and are left out of the mapping entirely.
        .filter((entry) => entry.item.str !== "");

    if (usable.length === 0) return [];

    const eolRatio = usable.filter((entry) => entry.item.hasEOL).length / usable.length;
    const trustEol = eolRatio > 0 && eolRatio < 0.9;
    // Relative to the page, not to the current item: a ruby or superscript run would otherwise
    // start a spurious line.
    const pageFontSize = medianOf(usable.map((entry) => fontSizeOf(entry.item)));
    const lineTolerance = 0.4 * (pageFontSize > 0 ? pageFontSize : 1);

    const pending: PendingLine[] = [];
    let current: PendingLine | null = null;
    let previousHadEol = false;

    for (const entry of usable) {
        const y = entry.item.transform[5];
        const startsNewLine = current === null || (trustEol && previousHadEol) || Math.abs(y - current.y) > lineTolerance;

        if (startsNewLine) {
            current = { entries: [], y, fontSize: 0 };
            pending.push(current);
        }

        current!.entries.push(entry);
        current!.fontSize = Math.max(current!.fontSize, fontSizeOf(entry.item));
        previousHadEol = entry.item.hasEOL;
    }

    // A run of items on one baseline, split wherever a gutter-sized gap interrupts it.
    const runs: Array<{ entries: (typeof pending)[number]["entries"]; y: number; fontSize: number }> = [];

    for (const line of pending) {
        // Single-column, horizontal writing: reading order within a line is left to right.
        const ordered = [...line.entries].sort((a, b) => a.item.transform[4] - b.item.transform[4]);
        const gutter = COLUMN_GAP_RATIO * (pageFontSize > 0 ? pageFontSize : 1);

        let current: typeof ordered = [];
        let previous: TextItemLike | null = null;

        for (const entry of ordered) {
            const gap = previous === null ? 0 : entry.item.transform[4] - (previous.transform[4] + previous.width);

            if (previous !== null && gap > gutter) {
                runs.push({ entries: current, y: line.y, fontSize: line.fontSize });
                current = [];
            }

            current.push(entry);
            previous = entry.item;
        }

        if (current.length > 0) runs.push({ entries: current, y: line.y, fontSize: line.fontSize });
    }

    const lines = runs.map((line) => {
        const ordered = line.entries;

        const pieces: LinePiece[] = [];
        let characters: string[] = [];
        let previous: TextItemLike | null = null;

        for (const { item, index } of ordered) {
            if (previous !== null) {
                const gap = item.transform[4] - (previous.transform[4] + previous.width);
                // A separating space belongs to no item, so it is left outside every piece.
                if (needsSeparatingSpace(previous, item, gap)) characters.push(" ");
            }

            const start = characters.length;
            characters = characters.concat([...item.str]);
            pieces.push({ itemIndex: index, start, end: characters.length });
            previous = item;
        }

        return {
            text: characters.join(""),
            pieces,
            itemIndexes: ordered.map((entry) => entry.index).sort((a, b) => a - b),
            x: ordered[0]?.item.transform[4] ?? 0,
            y: line.y,
            fontSize: line.fontSize,
        };
    });

    // PDF user space grows upward, so reading order is descending y.
    return lines.sort((a, b) => b.y - a.y);
};

const isTextItem = (item: TextContent["items"][number]): item is TextItem => (item as TextItem).str !== undefined;

/**
 * Share of a page's baselines that must carry side-by-side blocks before it reads as columned.
 *
 * Measured rather than guessed: the Bitcoin whitepaper is single-column but its figures put two
 * blocks on the same baseline on five of nine pages, peaking around 22%. A real two-column page is
 * near-total. Half separates them with room to spare, and keeps the warning from crying wolf.
 */
const MULTI_COLUMN_SHARE = 0.5;

/**
 * True when most of a page's baselines carry more than one block of text.
 *
 * After the gutter split, two columns show up as two lines at the same y. Spec §2 does not claim
 * to handle that layout: the split keeps the text from fusing, but the reading order between
 * columns is still row-by-row, so the page is reported rather than silently trusted.
 */
export const looksMultiColumn = (lines: readonly ExtractedLine[]): boolean => {
    if (lines.length === 0) return false;

    const perBaseline = new Map<number, number>();
    for (const line of lines) {
        const key = Math.round(line.y * 10);
        perBaseline.set(key, (perBaseline.get(key) ?? 0) + 1);
    }

    const shared = [...perBaseline.values()].filter((count) => count > 1).length;
    return shared / perBaseline.size >= MULTI_COLUMN_SHARE;
};

export type ExtractPdfOptions = {
    /** Aborts loading when the document is replaced mid-load. */
    signal?: AbortSignal;
};

/**
 * Loads a PDF and extracts every page's text.
 *
 * The caller owns the result and must call `destroy()` when it is finished with it.
 */
export const extractPdfText = async (bytes: Uint8Array, options: ExtractPdfOptions = {}): Promise<PdfExtraction> => {
    // `getDocument` transfers ownership of the buffer to the worker and detaches it here, so the
    // caller's copy must not be reused afterwards.
    const loadingTask = getDocument({ data: bytes, ...ASSET_URLS });

    options.signal?.addEventListener("abort", () => void loadingTask.destroy(), { once: true });

    const document = await loadingTask.promise;
    const pages: PageExtraction[] = [];
    const pagesWithoutText: number[] = [];
    const rotatedPages: number[] = [];
    const multiColumnPages: number[] = [];
    let totalCharacters = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const textContent = await page.getTextContent(TEXT_CONTENT_OPTIONS);

        // Item transforms are in unrotated page space, so baseline grouping is meaningless on a
        // quarter-turned page. Such a page is reported rather than segmented into nonsense.
        const isRotated = page.rotate % 180 !== 0;
        const lines = isRotated ? [] : groupItemsIntoLines(textContent.items.filter(isTextItem));
        const isMultiColumn = looksMultiColumn(lines);
        const characterCount = lines.reduce((total, line) => total + [...line.text].length, 0);

        if (isRotated) rotatedPages.push(pageNumber);
        else if (characterCount === 0) pagesWithoutText.push(pageNumber);
        if (isMultiColumn) multiColumnPages.push(pageNumber);

        totalCharacters += characterCount;
        pages.push({ pageNumber, textContent, lines, characterCount });
    }

    return {
        document,
        destroy: () => loadingTask.destroy(),
        pageCount: document.numPages,
        pages,
        pagesWithoutText,
        rotatedPages,
        multiColumnPages,
        totalCharacters,
    };
};
