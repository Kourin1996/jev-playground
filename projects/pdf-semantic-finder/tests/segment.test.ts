/**
 * Extraction and segmentation tests (spec §5, §6.1).
 *
 * Everything here runs on synthetic items; no PDF is involved.
 */
import { describe, expect, it } from "vitest";
import { buildSegments, formatSegmentId, normalizeForSearch } from "@/lib/pdf/build-segments";
import { groupItemsIntoLines, looksMultiColumn, needsSeparatingSpace } from "@/lib/pdf/extract-text";
import { LIMITS, countCharacters } from "@/lib/types";
import type { TextItemLike } from "@/lib/types";
import { block, line, splitLine } from "./fixtures/text-items";

const toPage = (items: TextItemLike[], pageNumber = 1) => ({
    pageNumber,
    lines: groupItemsIntoLines(items),
});

describe("groupItemsIntoLines", () => {
    it("groups items sharing a baseline into one line", () => {
        const first = line({ y: 700, text: "Article 1", x: 72, hasEOL: false });
        const items = [first, line({ y: 700, text: "Definitions", x: 72 + first.width + 5, hasEOL: true })];

        const lines = groupItemsIntoLines(items);

        expect(lines).toHaveLength(1);
        expect(lines[0].itemIndexes).toEqual([0, 1]);
    });

    it("splits a baseline at a gutter-sized gap rather than fusing two columns", () => {
        // Grouping on baseline alone turns two columns into one sentence, which then reaches Jev as
        // something the document never said.
        const left = line({ y: 700, text: "左の段の本文です。", x: 60, hasEOL: false });
        const items = [left, line({ y: 700, text: "右の段の本文です。", x: 60 + left.width + 12 * 10.5, hasEOL: true })];

        const lines = groupItemsIntoLines(items);

        expect(lines).toHaveLength(2);
        expect(lines[0].text).toBe("左の段の本文です。");
        expect(lines[1].text).toBe("右の段の本文です。");
    });

    it("reports a page as columned only when most baselines are shared", () => {
        // A figure puts two blocks on one baseline without making the page two-column.
        const occasional = [
            ...block(700, ["本文の行です。", "本文の行です。", "本文の行です。", "本文の行です。"]),
            line({ y: 620, text: "図の左", x: 60, hasEOL: false }),
            line({ y: 620, text: "図の右", x: 400, hasEOL: true }),
        ];
        expect(looksMultiColumn(groupItemsIntoLines(occasional))).toBe(false);

        const columned = [0, 1, 2, 3].flatMap((row) => [
            line({ y: 700 - row * 16, text: "左の段の本文", x: 60, hasEOL: false }),
            line({ y: 700 - row * 16, text: "右の段の本文", x: 400, hasEOL: true }),
        ]);
        expect(looksMultiColumn(groupItemsIntoLines(columned))).toBe(true);
    });

    it("emits lines in reading order, which is descending y in PDF user space", () => {
        const items = [line({ y: 600, text: "second" }), line({ y: 700, text: "first" })];

        expect(groupItemsIntoLines(items).map((entry) => entry.text)).toEqual(["first", "second"]);
    });

    it("groups by position when the producer never sets hasEOL", () => {
        const items = block(700, ["一行目", "二行目", "三行目"]).map((item) => ({ ...item, hasEOL: false }));

        expect(groupItemsIntoLines(items)).toHaveLength(3);
    });

    it("ignores hasEOL when the producer sets it on nearly every item", () => {
        // Three items on one baseline, each flagged: trusting the flag would emit three lines.
        const items = splitLine({ y: 700, text: "中途解約の場合", hasEOL: true }, 3).map((item) => ({
            ...item,
            hasEOL: true,
        }));

        expect(groupItemsIntoLines(items)).toHaveLength(1);
    });

    it("leaves out items with an empty string, whose elements are never in the DOM", () => {
        const items = [
            line({ y: 700, text: "前段", hasEOL: false }),
            { ...line({ y: 700, text: "", hasEOL: false }), str: "" },
            line({ y: 700, text: "後段", hasEOL: true }),
        ];

        expect(groupItemsIntoLines(items)[0].itemIndexes).toEqual([0, 2]);
    });

    it("joins a split Japanese run without inserting spaces", () => {
        const items = splitLine({ y: 700, text: "中途解約の場合、既払料金の返還は行わない。" }, 7);

        expect(groupItemsIntoLines(items)[0].text).toBe("中途解約の場合、既払料金の返還は行わない。");
    });

    it("inserts a space between Latin words separated by a real gap", () => {
        const first = line({ y: 700, text: "30", x: 72, hasEOL: false });
        const second = line({ y: 700, text: "days", x: 72 + first.width + 6, hasEOL: true });

        expect(groupItemsIntoLines([first, second])[0].text).toBe("30 days");
    });

    it("inserts no space where either side of the gap is CJK", () => {
        const first = line({ y: 700, text: "30", x: 72, hasEOL: false });
        const second = line({ y: 700, text: "日前", x: 72 + first.width + 6, hasEOL: true });

        expect(groupItemsIntoLines([first, second])[0].text).toBe("30日前");
        expect(needsSeparatingSpace(first, second, 6)).toBe(false);
    });
});

describe("normalizeForSearch", () => {
    it("is idempotent", () => {
        const once = normalizeForSearch("Ｆｅｅｓ　ｗｉｌｌ ＮＯＴ be refunded");
        expect(normalizeForSearch(once)).toBe(once);
    });

    it("folds fullwidth characters and case", () => {
        expect(normalizeForSearch("ＮＯ　Ｒｅｆｕｎｄ")).toBe("norefund");
    });

    it("folds halfwidth katakana", () => {
        expect(normalizeForSearch("ｶｲﾔｸ")).toBe(normalizeForSearch("カイヤク"));
    });

    it("matches across a space extraction introduced mid-word", () => {
        expect(normalizeForSearch("返 金")).toBe(normalizeForSearch("返金"));
    });

    it("strips zero-width characters", () => {
        expect(normalizeForSearch("返​金")).toBe("返金");
    });
});

describe("formatSegmentId", () => {
    it("zero-pads both components", () => {
        expect(formatSegmentId(3, 4)).toBe("p003-s004");
    });
});

describe("buildSegments", () => {
    const paragraph = (marker: string) =>
        `${marker}本サービスの利用者は、所定の手続に従い、当社の定める方法により申込みを行うものとする。` +
        "当社が承諾した時点で契約が成立し、利用者は当社の定める料金を支払う義務を負う。";

    it("packs short clauses together instead of emitting one segment each", () => {
        // Ten short clauses: splitting at every list-item start would emit ten segments and, on a
        // full document, breach the 80-segment cap well inside the character budget.
        const texts = Array.from({ length: 10 }, (_, index) => `（${index + 1}）利用者は当社に通知するものとする。`);
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.length).toBeLessThan(10);
        expect(segments.length).toBeGreaterThan(0);
    });

    it("reaches the derived minimum length where the text allows it", () => {
        const texts = Array.from({ length: 12 }, (_, index) => `（${index + 1}）` + paragraph(""));
        const segments = buildSegments([toPage(block(700, texts))]);

        for (const segment of segments.slice(0, -1)) {
            expect(countCharacters(segment.originalText)).toBeGreaterThanOrEqual(LIMITS.minSegmentCharacters);
        }
    });

    it("never exceeds the hard maximum", () => {
        const texts = Array.from({ length: 20 }, () => paragraph(""));
        const segments = buildSegments([toPage(block(700, texts))]);

        for (const segment of segments) {
            expect(countCharacters(segment.originalText)).toBeLessThanOrEqual(LIMITS.maxSegmentCharacters);
        }
    });

    it("splits a single overlong line rather than truncating it", () => {
        const overlong = "あ".repeat(LIMITS.maxSegmentCharacters * 2 + 50);
        const segments = buildSegments([toPage([line({ y: 700, text: overlong })])]);

        expect(segments.length).toBeGreaterThan(1);
        expect(segments.map((segment) => segment.originalText).join("")).toBe(overlong);
    });

    it("gives each part of a split line only the items it actually contains", () => {
        // Regression: the parts used to share the whole line's indexes, so selecting any one of
        // them highlighted all of them.
        const items = splitLine({ y: 700, text: "あ".repeat(LIMITS.maxSegmentCharacters * 2 + 50) }, 20);
        const segments = buildSegments([toPage(items)]);
        const allIndexes = segments.flatMap((segment) => segment.itemIndexes);

        expect(segments.length).toBeGreaterThan(1);
        expect(allIndexes.length).toBe(new Set(allIndexes).size);
    });

    it("keeps a split part's text inside the items it claims", () => {
        const items = splitLine({ y: 700, text: "あ".repeat(LIMITS.maxSegmentCharacters * 2 + 50) }, 20);
        const page = toPage(items);
        const segments = buildSegments([page]);

        for (const segment of segments) {
            const covered = page.lines
                .filter((entry) => entry.itemIndexes.some((index) => segment.itemIndexes.includes(index)))
                .reduce((total, entry) => total + countCharacters(entry.text), 0);

            // The claimed items must hold at least the segment's own characters.
            expect(covered).toBeGreaterThanOrEqual(countCharacters(segment.originalText));
        }
    });

    it("keeps a ただし continuation with the text it qualifies", () => {
        const texts = [
            "第5条 利用者は、契約期間の満了前に本契約を解約することができる。解約の効力は当社が承諾した日に生じる。",
            "ただし、既に支払われた料金の返還は行わないものとする。",
        ];
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments).toHaveLength(1);
        expect(segments[0].originalText).toContain("ただし");
    });

    it("keeps every segment inside one physical page", () => {
        const segments = buildSegments([toPage(block(700, ["第1条 目的", paragraph("")]), 1), toPage(block(700, ["第2条 定義", paragraph("")]), 2)]);

        expect(new Set(segments.map((segment) => segment.pageNumber))).toEqual(new Set([1, 2]));
        for (const segment of segments) expect(segment.id.startsWith(`p00${segment.pageNumber}`)).toBe(true);
    });

    it("numbers segments per page, in order, with a well-formed id", () => {
        const segments = buildSegments([
            toPage(
                block(
                    700,
                    Array.from({ length: 8 }, () => paragraph("")),
                ),
                2,
            ),
        ]);

        segments.forEach((segment, index) => {
            expect(segment.id).toBe(formatSegmentId(2, index + 1));
            expect(segment.id).toMatch(/^p\d{3}-s\d{3}$/u);
        });
    });

    it("covers every non-empty item exactly once across a page", () => {
        const items = block(
            700,
            Array.from({ length: 12 }, (_, index) => `（${index + 1}）` + paragraph("")),
        );
        const page = toPage(items);
        const segments = buildSegments([page]);

        const expected = items.map((_, index) => index);
        const seen = segments.flatMap((segment) => segment.itemIndexes);
        const unique = [...new Set(seen)].sort((a, b) => a - b);

        expect(unique).toEqual(expected);
    });

    it("stores item indexes ascending", () => {
        const items = [line({ y: 700, text: "後半です。", x: 300, hasEOL: false }), line({ y: 700, text: "前半は", x: 72, hasEOL: true })];
        const segments = buildSegments([toPage(items)]);

        expect(segments[0].itemIndexes).toEqual([0, 1]);
        // Reading order still governs the text, so display order and index order differ.
        expect(segments[0].originalText).toBe("前半は後半です。");
    });

    it("derives searchText from originalText with the shared normalization", () => {
        const segments = buildSegments([toPage(block(700, [paragraph("")]))]);

        for (const segment of segments) {
            expect(segment.searchText).toBe(normalizeForSearch(segment.originalText));
        }
    });
});
