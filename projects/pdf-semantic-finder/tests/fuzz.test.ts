/**
 * Property checks over generated input.
 *
 * The pure modules carry invariants that are easy to state and easy to break accidentally:
 * every segment fits the declared maximum, every text item belongs to exactly one segment, IDs are
 * well formed and sequential, and ranking never invents or loses a result. These run over many
 * generated pages rather than a handful of hand-written ones.
 */
import { describe, expect, it } from "vitest";
import { buildSegments, formatSegmentId, normalizeForSearch, normalizeWithOffsets } from "@/lib/pdf/build-segments";
import { groupItemsIntoLines } from "@/lib/pdf/extract-text";
import { buildPageIndex } from "@/lib/pdf/page-index";
import { exactSearch } from "@/lib/search/exact-search";
import { LIMITS, SEGMENT_ID_PATTERN, countCharacters } from "@/lib/types";
import type { TextItemLike } from "@/lib/types";
import { packBatches } from "../worker/search/build-jev-request";
import { rankResults } from "../worker/search/rank-results";
import { validateJevAnswer, validateSearchRequest } from "../worker/search/validate";
import type { JevScoreAnswer } from "../worker/search/validate";

/** Deterministic generator, so a failure is reproducible from its seed. */
const makeRandom = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const CHARS = ["あ", "漢", "ｶ", "A", "z", "1", "。", "、", "（", "）", " ", "　", "-", "第", "①", "𠮟"];

const makePage = (random: () => number, pageNumber: number): { pageNumber: number; items: TextItemLike[] } => {
    const items: TextItemLike[] = [];
    const lineCount = 1 + Math.floor(random() * 40);
    let y = 700;

    for (let line = 0; line < lineCount; line += 1) {
        const fontSize = [6, 9, 10.5, 12, 16][Math.floor(random() * 5)];
        const runCount = 1 + Math.floor(random() * 6);
        let x = 60;

        for (let run = 0; run < runCount; run += 1) {
            const length = Math.floor(random() * 60);
            let str = "";
            for (let k = 0; k < length; k += 1) str += CHARS[Math.floor(random() * CHARS.length)];
            const width = [...str].length * fontSize * 0.95;

            items.push({
                str,
                transform: [fontSize, 0, 0, fontSize, x, y],
                width,
                height: fontSize,
                hasEOL: run === runCount - 1 && random() < 0.8,
            });
            x += width + (random() < 0.15 ? fontSize : 0);
        }

        y -= fontSize * (1 + random());
    }

    return { pageNumber, items };
};

describe("segmentation invariants", () => {
    const seeds = Array.from({ length: 120 }, (_, index) => index + 1);

    it.each(seeds)("hold for generated page set %i", (seed) => {
        const random = makeRandom(seed);
        const pageCount = 1 + Math.floor(random() * 4);
        const raw = Array.from({ length: pageCount }, (_, index) => makePage(random, index + 1));
        const pages = raw.map((page) => ({ pageNumber: page.pageNumber, lines: groupItemsIntoLines(page.items) }));
        const segments = buildSegments(pages);

        for (const page of raw) {
            const own = segments.filter((segment) => segment.pageNumber === page.pageNumber);

            // IDs are well formed and numbered from 1, in order, per page.
            own.forEach((segment, index) => {
                expect(segment.id).toMatch(SEGMENT_ID_PATTERN);
                expect(segment.id).toBe(formatSegmentId(page.pageNumber, index + 1));
            });

            // A claimed index always points at an item that produced a rendered element, and no
            // index is claimed twice. Items whose string is empty produce an element PDF.js never
            // inserts, and a line of nothing but spaces is dropped, so the reverse containment is
            // deliberately not asserted.
            const renderable = new Set(
                page.items
                    .map((item, index) => ({ item, index }))
                    .filter((entry) => entry.item.str !== "")
                    .map((entry) => entry.index),
            );
            const claimed = own.flatMap((segment) => segment.itemIndexes);

            for (const index of claimed) expect(renderable.has(index)).toBe(true);
            expect(new Set(claimed).size).toBe(claimed.length);
        }

        for (const segment of segments) {
            expect(countCharacters(segment.originalText)).toBeLessThanOrEqual(LIMITS.maxSegmentCharacters);
            expect(segment.originalText.length).toBeGreaterThan(0);
            expect(segment.searchText).toBe(normalizeForSearch(segment.originalText));
            expect([...segment.itemIndexes]).toEqual([...segment.itemIndexes].sort((a, b) => a - b));
        }
    });
});

describe("normalizeForSearch", () => {
    it("is idempotent and whitespace-free over generated text", () => {
        const random = makeRandom(99);
        for (let attempt = 0; attempt < 500; attempt += 1) {
            let text = "";
            for (let k = 0; k < Math.floor(random() * 40); k += 1) text += CHARS[Math.floor(random() * CHARS.length)];
            const once = normalizeForSearch(text);
            expect(normalizeForSearch(once)).toBe(once);
            expect(/\s/u.test(once)).toBe(false);
        }
    });

    it("makes exact search find any substring of a page's own normalized text", () => {
        const random = makeRandom(7);
        const page = makePage(random, 1);
        const lines = groupItemsIntoLines(page.items);
        const index = buildPageIndex(1, lines);

        for (let attempt = 0; attempt < 50; attempt += 1) {
            if (index.searchText.length < 4) break;
            const start = Math.floor(random() * (index.searchText.length - 3));
            const needle = index.searchText.slice(start, start + 3);
            const outcome = exactSearch([index], needle);

            expect(outcome.ok).toBe(true);
            if (outcome.ok) expect(outcome.hits.length).toBeGreaterThan(0);
        }
    });

    it("keeps offsets aligned with the normalization used for segments", () => {
        const random = makeRandom(4242);
        for (let attempt = 0; attempt < 400; attempt += 1) {
            let text = "";
            for (let k = 0; k < Math.floor(random() * 40); k += 1) text += CHARS[Math.floor(random() * CHARS.length)];

            const mapped = normalizeWithOffsets(text);
            // One definition, two outputs: a drift here would make every match land on the wrong
            // characters while still looking correct in the results list.
            expect(mapped.text).toBe(normalizeForSearch(text));
            expect(mapped.sourceIndex).toHaveLength([...mapped.text].length);
            for (const index of mapped.sourceIndex) {
                expect(index).toBeGreaterThanOrEqual(0);
                expect(index).toBeLessThan([...text].length);
            }
            // Offsets never run backwards, so a match maps to a contiguous stretch of the source.
            for (let i = 1; i < mapped.sourceIndex.length; i += 1) {
                expect(mapped.sourceIndex[i]).toBeGreaterThanOrEqual(mapped.sourceIndex[i - 1]);
            }
        }
    });
});

describe("packBatches invariants", () => {
    it("never loses, reorders, or overfills", () => {
        const random = makeRandom(31);
        for (let attempt = 0; attempt < 300; attempt += 1) {
            const segments = Array.from({ length: Math.floor(random() * 60) }, (_, index) => ({
                id: formatSegmentId(1, index + 1),
                text: "あ".repeat(1 + Math.floor(random() * LIMITS.maxSegmentCharacters)),
            }));
            const batches = packBatches(segments);

            expect(batches.flat().map((entry) => entry.id)).toEqual(segments.map((entry) => entry.id));
            for (const batch of batches) {
                expect(batch.length).toBeGreaterThan(0);
                expect(batch.length).toBeLessThanOrEqual(LIMITS.maxSegmentsPerBatch);
                const characters = batch.reduce((total, entry) => total + countCharacters(entry.text), 0);
                if (batch.length > 1) expect(characters).toBeLessThanOrEqual(LIMITS.maxCharactersPerBatch);
            }
        }
    });
});

describe("rankResults invariants", () => {
    it("returns a correctly ordered subset and never invents a result", () => {
        const random = makeRandom(53);
        for (let attempt = 0; attempt < 300; attempt += 1) {
            const count = 1 + Math.floor(random() * 40);
            const segments = Array.from({ length: count }, (_, index) => ({
                id: formatSegmentId(1, index + 1),
                text: "本文",
            }));
            const answers = new Map<string, JevScoreAnswer>(
                segments.map((segment) => {
                    const relevant = Math.round(random() * 100) / 100;
                    const rest = Math.round((1 - relevant) * 100) / 100;
                    return [segment.id, { score: relevant * 2, confidence: random(), probabilities: { "0": 0, "1": rest, "2": relevant } }];
                }),
            );

            const outcome = rankResults(segments, answers);
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) continue;

            const ids = new Set(segments.map((segment) => segment.id));
            expect(outcome.results.length).toBeLessThanOrEqual(LIMITS.maxResults);
            for (const result of outcome.results) expect(ids.has(result.segmentId)).toBe(true);
            expect(new Set(outcome.results.map((r) => r.segmentId)).size).toBe(outcome.results.length);

            for (let index = 1; index < outcome.results.length; index += 1) {
                expect(outcome.results[index - 1].relevantProbability).toBeGreaterThanOrEqual(outcome.results[index].relevantProbability);
            }

            const best = Math.max(...[...answers.values()].map((a) => a.probabilities["2"]));
            const expectedStatus = best >= 0.65 ? "matched" : best >= 0.35 ? "uncertain" : "no_match";
            expect(outcome.status).toBe(expectedStatus);
            if (expectedStatus === "no_match") expect(outcome.results).toEqual([]);
            else expect(outcome.results.length).toBeGreaterThan(0);
        }
    });
});

describe("validation never throws", () => {
    it("survives arbitrary request bodies", () => {
        const random = makeRandom(11);
        const values: unknown[] = [null, undefined, 0, "", [], {}, NaN, Infinity, -1, "x".repeat(5000), { id: 1 }];
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const body: Record<string, unknown> = {
                documentId: values[Math.floor(random() * values.length)],
                requestId: values[Math.floor(random() * values.length)],
                query: values[Math.floor(random() * values.length)],
                segments: random() < 0.5 ? values[Math.floor(random() * values.length)] : [values[Math.floor(random() * values.length)]],
            };
            expect(() => validateSearchRequest(body, Math.floor(random() * 500_000))).not.toThrow();
            expect(() => validateJevAnswer(body)).not.toThrow();
        }
    });
});
