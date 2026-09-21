/**
 * Extraction and segmentation tests (spec §5, §6.1).
 *
 * Everything here runs on synthetic items; no PDF is involved.
 */
import { describe, expect, it } from "vitest";
import { buildSegments, formatSegmentId, normalizeForSearch, normalizeWithOffsets } from "@/lib/pdf/build-segments";
import { groupItemsIntoLines, looksMultiColumn, needsSeparatingSpace, orderByColumn } from "@/lib/pdf/extract-text";
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
        expect(normalizeForSearch("ｶｲﾔｸ")).toBe("カイヤク");
    });

    it("folds halfwidth katakana carrying a dakuten", () => {
        // `ｶ` and `ﾞ` only compose into `ガ` when folded together. Folding them separately yields
        // `カ` plus a combining mark, which never matches a query typed as `ガ` — and halfwidth
        // katakana with dakuten is ordinary Japanese, not an exotic case.
        expect(normalizeForSearch("ｶﾞｲ")).toBe("ガイ");
        expect(normalizeForSearch("ﾊﾟｰﾂ")).toBe("パーツ");
        expect(normalizeForSearch("ﾍﾞｰｽ")).toBe("ベース");
        // A decomposed sequence composes the same way.
        expect(normalizeForSearch("か\u3099")).toBe("が");
    });

    it("folds a mark onto its base across anything extraction put between them", () => {
        // Extraction inserts a space wherever the font changes mid-word, and a line break lands in
        // the same position, so a base and its dakuten routinely arrive separated. Clustering on
        // whatever sits immediately next in the input misses every one of these.
        for (const [separator, name] of [
            [" ", "space"],
            ["\u3000", "ideographic space"],
            ["\n", "line break"],
            ["\u200B", "zero-width space"],
        ] as const) {
            expect(normalizeForSearch(`ｶ${separator}ﾞ`), `halfwidth dakuten across a ${name}`).toBe("ガ");
            expect(normalizeForSearch(`ﾊ${separator}ﾟ`), `halfwidth handakuten across a ${name}`).toBe("パ");
            expect(normalizeForSearch(`か${separator}\u3099`), `combining dakuten across a ${name}`).toBe("が");
        }

        // And the source range still spans everything the fold consumed, separator included, so a
        // match can be carried back to the text items it covers.
        const mapped = normalizeWithOffsets("あｶ ﾞい");
        expect(mapped.text).toBe("あガい");
        expect(mapped.sourceStart).toEqual([0, 1, 4]);
        expect(mapped.sourceEnd).toEqual([1, 4, 5]);
    });

    it("matches across a space extraction introduced mid-word", () => {
        expect(normalizeForSearch("返 金")).toBe(normalizeForSearch("返金"));
    });

    it("strips zero-width characters", () => {
        expect(normalizeForSearch("返​金")).toBe("返金");
    });
});

describe("orderByColumn", () => {
    /** Two columns of `rows` lines each, left at x=72 and right at x=320. */
    const twoColumns = (rows: number) => {
        const items: TextItemLike[] = [];
        for (let row = 0; row < rows; row += 1) {
            for (const [x, side] of [
                [72, "左"],
                [320, "右"],
            ] as const) {
                const text = `${side}第${row + 1}項 本項については別途協議する。`;
                items.push({ str: text, transform: [10.5, 0, 0, 10.5, x, 700 - row * 16], width: [...text].length * 10, height: 10.5, hasEOL: true });
            }
        }
        return items;
    };

    it("reads down one column and then down the next", () => {
        // Baseline order reads across the gutter, which does not merely reorder the text: the left
        // column's sentence is cut and the right column's is inserted into it.
        const lines = groupItemsIntoLines(twoColumns(4));
        expect(looksMultiColumn(lines)).toBe(true);

        const ordered = orderByColumn(lines, 10.5).map((line) => line.text);
        expect(ordered).toEqual([
            "左第1項 本項については別途協議する。",
            "左第2項 本項については別途協議する。",
            "左第3項 本項については別途協議する。",
            "左第4項 本項については別途協議する。",
            "右第1項 本項については別途協議する。",
            "右第2項 本項については別途協議する。",
            "右第3項 本項については別途協議する。",
            "右第4項 本項については別途協議する。",
        ]);
    });

    it("keeps a segment's text inside one column", () => {
        const pages = [toPage(twoColumns(6))];
        const inOrder = buildSegments([{ pageNumber: 1, lines: orderByColumn(groupItemsIntoLines(twoColumns(6)), 10.5) }]);
        expect(pages.length).toBe(1);

        // Nothing built from a columned page may carry both sides: that is the corruption, not the
        // ordering, and it is what makes every judgement about such a passage meaningless.
        for (const segment of inOrder) {
            const both = segment.originalText.includes("左第") && segment.originalText.includes("右第");
            expect(both, `columns fused: ${segment.originalText.slice(0, 60)}`).toBe(false);
        }
    });

    it("leaves a single-column page in baseline order", () => {
        const lines = groupItemsIntoLines(
            block(700, ["第1条（目的）本契約の目的を定める。", "第2条（定義）用語の意味を定める。", "第3条（料金）対価を定める。"]),
        );
        expect(orderByColumn(lines, 10.5).map((line) => line.text)).toEqual(lines.map((line) => line.text));
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

    it("coalesces a run of fragments rather than emitting one unit per line", () => {
        // Ten short lines that answer nothing on their own: no sentence ends anywhere, which is
        // what a figure's labels, a formula, or a table of headings looks like after extraction.
        // Evaluating ten of these would spend ten slots on fragments.
        const texts = Array.from({ length: 10 }, (_, index) => `項目${index + 1} 区分 金額`);
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.length).toBeLessThan(10);
        expect(segments.length).toBeGreaterThan(0);
    });

    it("keeps short numbered clauses apart, however short they are", () => {
        // The counterpart to the test above, and the reason length alone cannot decide. Each of
        // these answers a different question in one sentence; merging them reproduces the defect
        // the 250-character floor was removed to end, at a smaller number.
        const texts = ["第4条　中途解約はできない。", "第5条　返金は行わない。", "第6条　契約期間は1年間とする。", "第7条　譲渡を禁止する。"];
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.map((segment) => segment.originalText)).toEqual(texts);
    });

    it("keeps short provisions apart even when none of them ends a sentence", () => {
        // The third counterexample to the same defect. A 250-character floor merged these, then a
        // 40-character one did, then a sentence-ending rule did — each time because one heuristic
        // was standing in for "is this a provision". None of these ends in 。 and each answers a
        // different question.
        const texts = ["第5条　返金不可", "第6条　解約手数料無料", "第7条　譲渡禁止", "第8条　準拠法は日本法"];
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.map((segment) => segment.originalText)).toEqual(texts);
    });

    it("still folds a heading into the text it introduces, in either script", () => {
        // The counterpart. `第N章` and a bare Latin `N.` mark headings at least as often as
        // provisions, so they stay outside the protection and merge forward as before.
        const japanese = buildSegments([
            toPage(block(700, ["第2章 利用条件", "第1条（目的）本契約は、甲が乙に対して提供する本サービスの利用条件を定めることを目的とする。"])),
        ]);
        expect(japanese).toHaveLength(1);
        expect(japanese[0].originalText.startsWith("第2章 利用条件")).toBe(true);
        expect(japanese[0].originalText).toContain("本契約は、甲が乙に対して");

        const latin = buildSegments([
            toPage(
                block(700, ["4. Proof-of-Work", "To implement a distributed timestamp server on a peer-to-peer basis, we will need a proof-of-work system."]),
            ),
        ]);
        expect(latin).toHaveLength(1);
        expect(latin[0].originalText.startsWith("4. Proof-of-Work")).toBe(true);
        expect(latin[0].originalText).toContain("distributed timestamp server");
    });

    it("folds an orphaned paragraph tail back into the paragraph it came from", () => {
        // A wrapped paragraph whose last line is a single word still ends a sentence, so the
        // forward rule alone would let it stand — the Bitcoin whitepaper produced a unit
        // consisting of the word "ownership." exactly that way. It belongs to the lines before it.
        //
        // The pitch is what makes this reproducible: the wider gaps on either side of the tail are
        // paragraph boundaries, so the tail is closed into a group of its own before merging runs.
        const items = [
            line({ y: 700, text: "デジタル署名は所有権の移転を証明する手段として広く用いられており、本項の" }),
            line({ y: 684, text: "定めもこれに従うものとする。当事者は本項の趣旨を尊重しなければならない" }),
            line({ y: 668, text: "が、これを妨げる事情がある場合はこの限りでない。なお本項は例示である" }),
            line({ y: 628, text: "所有権。" }),
            line({ y: 588, text: "第9条（通知）甲は、乙に対し、書面により通知するものとする。通知は到達し" }),
            line({ y: 572, text: "た時点で効力を生じるものとし、甲乙間に別段の合意がある場合を除く。" }),
            line({ y: 556, text: "当事者は通知先の変更を相手方に速やかに届け出るものとする。" }),
        ];
        const segments = buildSegments([toPage(items)]);

        expect(segments.some((segment) => segment.originalText === "所有権。")).toBe(false);
        // Backward, not forward: it belongs to the paragraph above, not to the 第9条 below it.
        const owner = segments.find((segment) => segment.originalText.includes("所有権。"));
        expect(owner?.originalText).toContain("デジタル署名");
        expect(owner?.originalText).not.toContain("第9条");
    });

    it("keeps a clause that answers on its own as its own unit", () => {
        // Each of these clears the fragment threshold, so each stands alone. Under the old
        // 250-character capacity floor all three were packed into one unit, and a question
        // answered by the 中途解約 clause came back presented as three articles.
        const clauses = [
            "第3条（料金）乙は、本サービスの対価として、甲の定める月額料金を毎月末日までに支払うものとする。支払に要する費用は乙の負担とする。",
            "第4条（中途解約）乙は、契約期間の満了前であっても、一箇月前までに書面で通知することにより、本契約を解約することができる。",
            "第5条（返金）前条により解約した場合であっても、甲は既に受領した料金を返還しないものとする。ただし、甲の責めに帰すべき事由による場合はこの限りでない。",
        ];
        const segments = buildSegments([toPage(block(700, clauses))]);

        expect(segments).toHaveLength(3);
        expect(segments[1].originalText).toContain("第4条");
        expect(segments[1].originalText).not.toContain("第5条");
    });

    it("attaches a heading to the text it introduces", () => {
        // A heading on its own answers nothing, and it belongs ahead of its body rather than at
        // the tail of the section before it. The clause opener on the next line is what closes the
        // heading into a group of its own, so the merge is what has to put them back together.
        const items = [
            line({ y: 700, text: "第2章 利用条件" }),
            line({ y: 684, text: "第1条（目的）本契約は、甲が乙に対して提供する本サービスの利用条件を定め" }),
            line({ y: 668, text: "ることを目的とする。本サービスの内容は甲が別途定める利用案内による。" }),
        ];
        const segments = buildSegments([toPage(items)]);

        expect(segments).toHaveLength(1);
        expect(segments[0].originalText.startsWith("第2章 利用条件")).toBe(true);
        // Standing alone would also start with the heading, so the body has to be in there too.
        expect(segments[0].originalText).toContain("本契約は、甲が乙に対して");
    });

    it("does not let a figure's labels decide what the body font size is", () => {
        // Page 2 of the Bitcoin whitepaper: the transaction diagram's labels outnumber the lines
        // of prose, so the median font size came out as the label font and every line of prose was
        // larger than "the body size" — and therefore a heading. The page came back as twenty
        // consecutive one-line segments, each cut mid-sentence.
        const prose = [
            "We define an electronic coin as a chain of digital signatures. Each owner transfers the coin to the",
            "next by digitally signing a hash of the previous transaction and the public key of the next owner",
            "and adding these to the end of the coin. A payee can verify the signatures to verify the chain of",
            "ownership.",
        ];
        const labels = ["Hash", "Verify", "Sign", "Owner 1's", "Owner 2's", "Public Key", "Private Key", "Transaction"];

        const items = [
            ...prose.map((text, index) => line({ y: 700 - index * 16, text })),
            // More labels than prose lines, and smaller, which is what a diagram looks like.
            ...labels.map((text, index) => line({ y: 600 - index * 16, text, fontSize: 8 })),
        ];
        const segments = buildSegments([toPage(items)]);

        const opening = segments.find((segment) => segment.originalText.includes("We define an electronic coin"));
        expect(opening?.originalText, "the prose was split line by line").toContain("A payee can verify the signatures");
    });

    it("waits for the end of a sentence before taking the soft cut", () => {
        // 450 characters is "close at the next opportunity", and a line boundary is not one: lines
        // in justified prose end wherever the measure runs out. Six 96-character lines put the
        // soft limit inside the fifth, and the sentence does not finish until the sixth.
        const run = "proof of work involves scanning for a value that when hashed begins with a number of zero bits, and";
        const texts = [run, run, run, run, run, "the work required is exponential in the number of zero bits."];
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments).toHaveLength(1);
        expect(segments[0].originalText.endsWith("exponential in the number of zero bits.")).toBe(true);
        expect(countCharacters(segments[0].originalText)).toBeGreaterThan(LIMITS.softMaxSegmentCharacters);
    });

    it("cuts back to the last full stop when the hard maximum is reached", () => {
        // The hard maximum has to fall somewhere, but not mid-sentence. Twenty 42-character lines
        // put the 800-character cap inside the last one, and the only full stop before it is on
        // line 10 — so the nine lines after it belong to the next unit, not stranded at the end of
        // this one. Fixed-width filler because the arithmetic is the point of the test.
        const running = "あ".repeat(42);
        const finished = `${"あ".repeat(41)}。`;
        const texts = [...Array.from({ length: 9 }, () => running), finished, ...Array.from({ length: 9 }, () => running), finished];
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.length).toBeGreaterThan(1);
        for (const segment of segments) {
            expect(countCharacters(segment.originalText)).toBeLessThanOrEqual(LIMITS.maxSegmentCharacters);
            expect(segment.originalText.endsWith("。"), `cut mid-sentence: …${segment.originalText.slice(-20)}`).toBe(true);
        }
    });

    it("never exceeds the hard maximum", () => {
        const texts = Array.from({ length: 20 }, () => paragraph(""));
        const segments = buildSegments([toPage(block(700, texts))]);

        for (const segment of segments) {
            expect(countCharacters(segment.originalText)).toBeLessThanOrEqual(LIMITS.maxSegmentCharacters);
        }
    });

    it("never exceeds the hard maximum in Latin text either, where joining adds a space per line", () => {
        /*
         * Regression, found on the deployed site rather than here.
         *
         * The test above passes on Japanese for a reason that hides the defect: `joinLines` inserts
         * no space where either side of a line break is CJK, so the assembled text is exactly the
         * sum of its lines. In English every join adds one character, and the group length was
         * summed from the lines rather than measured on what they assemble into — so a group of N
         * lines could reach `maxSegmentCharacters + N - 1`.
         *
         * A seven-page English contract produced one segment of 805 characters. The Worker measures
         * the text that arrives, refused the whole document with `segment_text_too_long`, and the
         * reader saw only "The search could not be completed."
         *
         * Short wrapped lines with no sentence end are the shape that maximises the number of joins
         * inside one group, which is what makes the overshoot largest.
         */
        const texts = Array.from({ length: 60 }, (_, index) => `clause ${index} of the agreement between the parties hereto`);
        const segments = buildSegments([toPage(block(700, texts))]);

        expect(segments.length).toBeGreaterThan(1);
        for (const segment of segments) {
            expect(countCharacters(segment.originalText), `over the cap: ${countCharacters(segment.originalText)}`).toBeLessThanOrEqual(
                LIMITS.maxSegmentCharacters,
            );
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

    it("gives each part of a split item its own character range, not the whole item", () => {
        // A single text item longer than the hard maximum is split into several segments, and
        // `itemIndexes` can only say "item 0" for every one of them — so a meaning result would
        // light up all 2,000 characters whichever part the reader selected.
        const overlong = "あ".repeat(LIMITS.maxSegmentCharacters * 2 + 400);
        const segments = buildSegments([toPage([line({ y: 700, text: overlong })])]);

        expect(segments.length).toBeGreaterThan(2);
        // Every part still claims the same item, which is why the indexes alone cannot separate them.
        expect(new Set(segments.flatMap((segment) => segment.itemIndexes))).toEqual(new Set([0]));

        // The ranges do separate them: each covers exactly its own part, end to end with no gap
        // and no overlap, and none of them claims the whole item.
        let expectedStart = 0;
        for (const segment of segments) {
            expect(segment.ranges).toHaveLength(1);
            expect(segment.ranges[0].itemIndex).toBe(0);
            expect(segment.ranges[0].startOffset).toBe(expectedStart);
            expect(segment.ranges[0].endOffset - segment.ranges[0].startOffset).toBe(countCharacters(segment.originalText));
            expect(segment.ranges[0].wholeItem).toBe(false);
            expectedStart = segment.ranges[0].endOffset;
        }
        expect(expectedStart).toBe(countCharacters(overlong));
    });

    it("marks a segment that covers whole items as whole-item, so zooming does not rebuild it", () => {
        // The ordinary case. Keeping the class on the text-layer element instead of rewriting its
        // children is what lets a highlight survive a re-render of the layer.
        const segments = buildSegments([toPage(block(700, [paragraph("第1条（目的）"), paragraph("第2条（定義）")]))]);

        expect(segments.length).toBeGreaterThan(0);
        for (const segment of segments) {
            expect(segment.ranges.length).toBeGreaterThan(0);
            expect(segment.ranges.every((range) => range.wholeItem)).toBe(true);
        }
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
