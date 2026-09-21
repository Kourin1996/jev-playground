/**
 * Exact search, limit checks, and the meaning-search client (spec §2, §6.1, §9, §10).
 */
import { describe, expect, it, vi } from "vitest";
import { buildSegments, normalizeForSearch } from "@/lib/pdf/build-segments";
import { checkFileLimits, checkPageLimits, checkSegmentLimits, describeLimitViolation } from "@/lib/pdf/check-limits";
import { groupItemsIntoLines } from "@/lib/pdf/extract-text";
import { buildPageIndex } from "@/lib/pdf/page-index";
import { exactSearch } from "@/lib/search/exact-search";
import { buildSearchRequest, requestSemanticSearch } from "@/lib/search/semantic-search";
import { LIMITS } from "@/lib/types";
import type { PdfSegment } from "@/lib/types";
import { block } from "./fixtures/text-items";

const segmentsFrom = (texts: string[], pageNumber = 1): PdfSegment[] => buildSegments([{ pageNumber, lines: groupItemsIntoLines(block(700, texts)) }]);

const segment = (id: string, originalText: string, searchText: string, pageNumber = 1): PdfSegment => ({
    id,
    pageNumber,
    ranges: [],
    originalText,
    searchText,
    itemIndexes: [0],
});

describe("exactSearch", () => {
    /** One page built from the given lines of text, indexed the way the application does. */
    const pageOf = (texts: string[], pageNumber = 1) => buildPageIndex(pageNumber, groupItemsIntoLines(block(700, texts)));

    it("rejects an empty query rather than matching everything", () => {
        const outcome = exactSearch([pageOf(["本文があります。"])], "   ");

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("empty_query");
    });

    it("rejects a query of only zero-width characters", () => {
        const outcome = exactSearch([pageOf(["本文があります。"])], "\u200b\u200b");

        expect(outcome.ok).toBe(false);
    });

    it("returns occurrences in physical page and then document order", () => {
        const pages = [
            pageOf(["中途解約の場合、既払料金の返還は行わない。"], 1),
            pageOf(["利用者は当社に通知する。"], 2),
            pageOf(["既払料金の返還は行わない。"], 3),
        ];
        const outcome = exactSearch(pages, "既払料金の返還は行わない");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits.map((hit) => hit.pageNumber)).toEqual([1, 3]);
    });

    it("finds a phrase that straddles two segments", () => {
        // Segmentation cuts at the 第4条 opener, so a per-segment containment test cannot see a
        // phrase that spans the join — even though the page plainly contains it. The first clause
        // is padded past the fragment threshold so it is a unit in its own right rather than
        // being folded into the next one.
        const filler = "甲は、料金の改定を行う場合、相当な期間をもって乙に通知するものとする。";
        let first = "第3条（料金）乙は、本サービスの対価として、甲の定める月額料金を毎月末日までに支払うものとする。";
        while ([...first].length < LIMITS.minSegmentCharacters + 20) first += filler;
        first += "乙は遅延損害金を支払う。";

        let second = "第4条（中途解約）乙は、契約期間の満了前であっても、本契約を解約することができる。";
        // Both sides have to stand on their own: a trailing fragment is folded back into the
        // clause before it, which would put the phrase inside one segment after all.
        while ([...second].length < LIMITS.minSegmentCharacters + 20) second += filler;

        const texts = [first, second];
        const lines = groupItemsIntoLines(block(700, texts));
        const segments = buildSegments([{ pageNumber: 1, lines }]);

        expect(segments.length).toBeGreaterThan(1);
        const spanning = "乙は遅延損害金を支払う。第4条";
        expect(segments.some((segment) => segment.searchText.includes(normalizeForSearch(spanning)))).toBe(false);

        const outcome = exactSearch([buildPageIndex(1, lines)], spanning);

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits).toHaveLength(1);
    });

    it("finds a word whose dakuten was pushed onto the next line", () => {
        // `buildPageIndex` separates lines with a newline so they do not fuse in the preview. When
        // a halfwidth base ends one line and its mark starts the next, the page text holds
        // `ｶ` + newline + `ﾞ` — and a fold that clusters on whatever sits immediately next in the
        // input never composes them into the `ガ` the reader types.
        const lines = groupItemsIntoLines(block(700, ["ｶ", "ﾞｲﾄﾞ"]));
        const outcome = exactSearch([buildPageIndex(1, lines)], "ガイド");

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        expect(outcome.hits).toHaveLength(1);
        // The evidence covers both items, because the base and the mark live in different ones.
        expect(outcome.hits[0].ranges.map((range) => range.itemIndex)).toEqual([0, 1]);
    });

    it("finds a phrase that straddles a line break", () => {
        const lines = groupItemsIntoLines(block(700, ["契約期間の満了前であっても、", "本契約を解約することができる。"]));
        const outcome = exactSearch([buildPageIndex(1, lines)], "であっても、本契約を");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits).toHaveLength(1);
    });

    it("reports the characters a match covers, so the highlight follows the match", () => {
        const lines = groupItemsIntoLines(block(700, ["第1条 目的について定める。", "第2条 定義について定める。"]));
        const outcome = exactSearch([buildPageIndex(1, lines)], "定める。第2条");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            // The phrase crosses the line break, so both lines' items are covered.
            expect(outcome.hits[0].ranges.map((range) => range.itemIndex)).toEqual([0, 1]);
            // And only the matched characters within each, not the whole item.
            expect(outcome.hits[0].ranges.every((range) => range.wholeItem)).toBe(false);
        }
    });

    it("distinguishes two occurrences inside one text item", () => {
        // Both occurrences live in the same item, so item indexes alone cannot tell them apart —
        // selecting either would light up the identical span.
        const lines = groupItemsIntoLines(block(700, ["返金条件は第4条。返金申請は書面で行う。"]));
        const outcome = exactSearch([buildPageIndex(1, lines)], "返金");

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        expect(outcome.hits).toHaveLength(2);
        expect(outcome.hits[0].ranges).toHaveLength(1);
        expect(outcome.hits[1].ranges).toHaveLength(1);
        expect(outcome.hits[0].ranges[0].itemIndex).toBe(outcome.hits[1].ranges[0].itemIndex);
        // Same item, different characters.
        expect(outcome.hits[0].ranges[0].startOffset).toBe(0);
        expect(outcome.hits[1].ranges[0].startOffset).toBe(9);
    });

    it("returns every occurrence rather than capping at the ranked-result limit", () => {
        const page = pageOf(Array.from({ length: LIMITS.maxResults + 3 }, () => "解約について定める。"));
        const outcome = exactSearch([page], "解約");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits).toHaveLength(LIMITS.maxResults + 3);
    });

    it("matches through the shared normalization", () => {
        const page = pageOf(["第4条 中途解約の場合、既に支払われた料金の返還は行わないものとする。"]);
        const outcome = exactSearch([page], "返還は 行わない");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits).toHaveLength(1);
    });

    it("returns no occurrence rather than an error when the page does not contain the query", () => {
        const outcome = exactSearch([pageOf(["解約について定める。"])], "ログイン方法");

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.hits).toEqual([]);
    });
});

describe("limit checks", () => {
    it("accepts a file at the limit and rejects one above it", () => {
        expect(checkFileLimits(LIMITS.maxFileBytes)).toEqual([]);
        expect(checkFileLimits(LIMITS.maxFileBytes + 1)[0].kind).toBe("file_size");
    });

    it("accepts a page count at the limit and rejects one above it", () => {
        expect(checkPageLimits(LIMITS.maxPageCount)).toEqual([]);
        expect(checkPageLimits(LIMITS.maxPageCount + 1)[0].kind).toBe("page_count");
    });

    it("reports too many segments", () => {
        const many = Array.from({ length: LIMITS.maxSegmentCount + 1 }, (_, index) => segment(`p001-s${String(index).padStart(3, "0")}`, "短文", "短文"));

        expect(checkSegmentLimits(many).map((violation) => violation.kind)).toContain("segment_count");
    });

    it("reports too much extracted text, counting by code point", () => {
        // Surrogate pairs must count once, or the client and the Worker disagree.
        const text = "𠮟".repeat(LIMITS.maxSegmentCharacters);
        const count = Math.ceil(LIMITS.maxExtractedCharacters / LIMITS.maxSegmentCharacters) + 1;
        const segments = Array.from({ length: count }, (_, index) => segment(`p001-s${String(index).padStart(3, "0")}`, text, text));

        expect(checkSegmentLimits(segments).map((violation) => violation.kind)).toContain("extracted_characters");
    });

    it("accepts extracted text at the limit and rejects one character more", () => {
        // Built to land exactly on the limit; the cap is not a multiple of the per-segment cap.
        const full = Math.floor(LIMITS.maxExtractedCharacters / LIMITS.maxSegmentCharacters);
        const remainder = LIMITS.maxExtractedCharacters - full * LIMITS.maxSegmentCharacters;

        const atLimit = [
            ...Array.from({ length: full }, (_, index) => segment(`p001-s${String(index).padStart(3, "0")}`, "あ".repeat(LIMITS.maxSegmentCharacters), "x")),
            ...(remainder > 0 ? [segment("p002-s001", "あ".repeat(remainder), "x")] : []),
        ];

        expect(atLimit.reduce((total, entry) => total + [...entry.originalText].length, 0)).toBe(LIMITS.maxExtractedCharacters);
        expect(checkSegmentLimits(atLimit).map((violation) => violation.kind)).not.toContain("extracted_characters");

        const overLimit = [...atLimit, segment("p003-s001", "あ", "x")];
        expect(checkSegmentLimits(overLimit).map((violation) => violation.kind)).toContain("extracted_characters");
    });

    it("derives the segment cap from the measured unit size", () => {
        // The cap is what a full-size document is expected to produce, so a typical document
        // passes both checks. docs/spec.md §14.1 records the measurements behind the 125.
        expect(LIMITS.maxSegmentCount * LIMITS.typicalSegmentCharacters).toBe(LIMITS.maxExtractedCharacters);
        // A shape rule, not a capacity average: it must stay well below the typical unit, or it
        // starts merging real one-sentence clauses again.
        expect(LIMITS.minSegmentCharacters).toBeLessThan(LIMITS.typicalSegmentCharacters);
    });

    it("accepts a request body a document at the character cap can actually produce", () => {
        // Each segment's text travels three times: as itself and as both neighbours' context.
        // Under 256 KiB the Worker rejected a full-size Japanese document the client had already
        // accepted, and the reader saw a search error instead of a limit message.
        const worstCaseBytes = 3 * LIMITS.maxExtractedCharacters * 4 + LIMITS.maxSegmentCount * 80;

        expect(LIMITS.maxRequestBodyBytes).toBeGreaterThanOrEqual(worstCaseBytes);
    });

    it("can evaluate a document at the segment cap within the deadline it declares", () => {
        /*
         * Measured end to end rather than derived from a per-request guess. A 48-page fixture of
         * 1,872 units — 94% of the cap — completed in 7,148 / 7,330 / 7,390 ms through the real
         * provider at the declared concurrency, over 468 requests. Three runs varied by 3%.
         *
         * The earlier version of this test multiplied a 450 ms per-request figure taken from a
         * three-round search of a nine-page document, where fixed latency dominates. Thirty rounds
         * of a real document say more than three, so the margin below is smaller and the evidence
         * behind it is larger.
         */
        const measured = { segments: 1_872, elapsedMs: 7_390 };
        const projectedAtCap = (measured.elapsedMs / measured.segments) * LIMITS.maxSegmentCount;

        // Half again the measured time still fits, which covers a slower document and the one
        // retry §6.4 allows.
        expect(projectedAtCap * 1.5).toBeLessThanOrEqual(LIMITS.searchDeadlineMs);
    });

    it("declares no more capacity than the provider's token rate can deliver", () => {
        /*
         * Concurrency cannot buy a time below this, so a cap whose input could not be delivered
         * inside the deadline would be undeliverable however the requests were arranged.
         *
         * 602 input tokens per unit measured on the same fixture (1,126,884 over 1,872 units), and
         * 250,000 tokens a second from the provider's published rate limit.
         */
        const inputTokensAtCap = LIMITS.maxSegmentCount * 602;
        const floorMs = (inputTokensAtCap / 250_000) * 1_000;

        expect(floorMs).toBeLessThan(LIMITS.searchDeadlineMs / 2);
    });

    it("accepts a request body a document at the character cap can actually produce", () => {
        // Each segment's text travels three times: as itself and as both neighbours' context.
        // Under 256 KiB the Worker rejected a full-size Japanese document the client had already
        // accepted, and the reader saw a search error instead of a limit message.
        const worstCaseBytes = 3 * LIMITS.maxExtractedCharacters * 4 + LIMITS.maxSegmentCount * 80;

        expect(LIMITS.maxRequestBodyBytes).toBeGreaterThanOrEqual(worstCaseBytes);
    });

    it("reports the segment cap for a document that is short but heavily divided", () => {
        const segments = Array.from({ length: LIMITS.maxSegmentCount + 1 }, (_, index) =>
            segment(`p001-s${String(index).padStart(3, "0")}`, "短い条項。", "x"),
        );
        const kinds = checkSegmentLimits(segments).map((violation) => violation.kind);

        expect(kinds).toContain("segment_count");
        expect(kinds).not.toContain("extracted_characters");
    });

    it("describes every violation without quoting document content", () => {
        const messages = [
            describeLimitViolation({ kind: "file_size", actual: 20 * 1024 * 1024, limit: LIMITS.maxFileBytes }),
            describeLimitViolation({ kind: "page_count", actual: 42, limit: LIMITS.maxPageCount }),
            describeLimitViolation({ kind: "extracted_characters", actual: 99_999, limit: LIMITS.maxExtractedCharacters }),
            describeLimitViolation({ kind: "segment_count", actual: 200, limit: LIMITS.maxSegmentCount }),
        ];

        for (const message of messages) expect(message.length).toBeGreaterThan(0);
        expect(messages[1]).toContain("42");
    });
});

describe("buildSearchRequest", () => {
    const segments = segmentsFrom(["第4条 中途解約の場合、既に支払われた料金の返還は行わないものとする。"]);

    it("sends only the identifiers, the query, and the segment text", () => {
        const request = buildSearchRequest("doc-1", "req-1", "お金は戻る？", segments);

        expect(Object.keys(request).sort()).toEqual(["documentId", "query", "requestId", "segments"]);
        expect(Object.keys(request.segments[0]).sort()).toEqual(["id", "text"]);
    });

    it("sends the original text, not the normalized search text", () => {
        const request = buildSearchRequest("doc-1", "req-1", "q", segments);

        expect(request.segments[0].text).toBe(segments[0].originalText);
    });

    it("sends no page number, filename, or context", () => {
        const request = buildSearchRequest("doc-1", "req-1", "q", segments);
        const serialized = JSON.stringify(request);

        expect(serialized).not.toContain("pageNumber");
        expect(serialized).not.toContain("contextBefore");
        expect(request.segments.length).toBe(segments.length);
    });

    it("preserves document order, which the Worker relies on for its tie-break", () => {
        const multiple = [...segmentsFrom(["第1条 目的について定める。"], 1), ...segmentsFrom(["第2条 定義について定める。"], 2)];
        const request = buildSearchRequest("doc-1", "req-1", "q", multiple);

        expect(request.segments.map((entry) => entry.id)).toEqual(multiple.map((entry) => entry.id));
    });
});

describe("requestSemanticSearch", () => {
    const request = { documentId: "doc-1", requestId: "req-1", query: "q", segments: [{ id: "p001-s001", text: "本文" }] };
    const line = (message: unknown) => `${JSON.stringify(message)}\n`;
    const finalMessage = {
        type: "final",
        documentId: "doc-1",
        requestId: "req-1",
        status: "matched",
        results: [{ segmentId: "p001-s002", score: 2, relevantProbability: 0.97, confidence: 0.9 }],
        evaluatedSegmentCount: 2,
        model: "jev-1.13.0",
        elapsedMs: 10,
    };
    const progress = (evaluated: number) => ({ type: "progress", documentId: "doc-1", requestId: "req-1", evaluated, total: 12, results: [] });

    /** A `/api/search` answer delivered a chunk at a time, the way the Worker sends it. */
    const streamed = (chunks: readonly string[]) =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                    controller.close();
                },
            }),
            { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
        );

    it("returns the final line on success", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed([line(progress(4)), line(finalMessage)])),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal);

        expect(outcome.ok).toBe(true);
        // `type` belongs to the stream, not to the result.
        if (outcome.ok) expect(outcome.response).toEqual({ ...finalMessage, type: undefined });
    });

    it("reports each progress line before the final one", async () => {
        // The whole point of the stream: at the segment cap the search is 500 round-trips deep and
        // takes about five seconds, while the first answers come back in under half a second.
        const seen: number[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed([line(progress(4)), line(progress(8)), line(finalMessage)])),
        );

        await requestSemanticSearch(request, new AbortController().signal, (update) => seen.push(update.evaluated));

        expect(seen).toEqual([4, 8]);
    });

    it("reassembles a line split across chunks", async () => {
        // The body arrives in whatever pieces the network hands over, which need not be lines.
        const whole = line(progress(4)) + line(finalMessage);
        const cut = Math.floor(whole.length / 3);
        const seen: number[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)])),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal, (update) => seen.push(update.evaluated));

        expect(seen).toEqual([4]);
        expect(outcome.ok).toBe(true);
    });

    it("surfaces the application error code, never a no-match", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ error: { code: "provider_timeout", message: "The search could not be completed." } }, { status: 504 })),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal);

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_timeout");
    });

    it("surfaces an error that arrives after the headers", async () => {
        // A streamed body has already sent 200 by the time a batch fails, so the failure travels
        // as a line. It must still not become a no-match (spec §9.2).
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed([line(progress(4)), line({ type: "error", error: { code: "incomplete_evaluation", message: "…" } })])),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal);

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("incomplete_evaluation");
    });

    it("treats a stream that stops before the final line as a failure", async () => {
        // A connection dropped halfway has evaluated part of the document. Reporting what it found
        // would be reporting a search that never finished.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed([line(progress(4))])),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal);

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_malformed_response");
    });

    it("treats an unreadable body as a malformed response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => streamed(["not json\n"])),
        );

        const outcome = await requestSemanticSearch(request, new AbortController().signal);

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_malformed_response");
    });

    it("passes the abort signal through so a superseded search can be cancelled", async () => {
        const fetchImpl = vi.fn(async () => streamed([line(finalMessage)]));
        vi.stubGlobal("fetch", fetchImpl);
        const controller = new AbortController();

        await requestSemanticSearch(request, controller.signal);

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.signal).toBe(controller.signal);
    });
});
