/**
 * The shared provider budget and its token estimate (spec §9.3, §14.20).
 *
 * The estimator is only useful if it never comes out below what a real search consumed, so it is
 * checked against every row §14.20 measured rather than against itself.
 */
import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/types";
import { PROVIDER_BUDGET, emptyBudget, release, reserve } from "../worker/admission/budget";
import { estimateBatchInputTokens, estimateSearchInputTokens } from "../worker/admission/estimate-tokens";
import { packBatches } from "../worker/search/build-jev-request";

/** Segments of a given text length, with the context the client really sends alongside them. */
const segmentsOf = (count: number, characters: number, withContext = true) =>
    Array.from({ length: count }, (_, index) => ({
        id: `p001-s${String(index + 1).padStart(3, "0")}`,
        text: "あ".repeat(characters),
        ...(withContext && index > 0 ? { contextBefore: "い".repeat(characters) } : {}),
        ...(withContext && index < count - 1 ? { contextAfter: "う".repeat(characters) } : {}),
    }));

describe("estimateSearchInputTokens", () => {
    /**
     * The three searches §14.20 measured, and what they actually cost.
     *
     * The estimate may be generous — over-estimating admits fewer searches, which is the safe
     * direction — but it must never be optimistic, or the budget admits work the provider cannot
     * carry.
     */
    const measured = [
        { name: "bitcoin.pdf", units: 86, characters: 21_155, inputTokens: 45_440 },
        { name: "Japanese contract", units: 13, characters: 1_469, inputTokens: 10_542 },
        { name: "near-limit Japanese", units: 1_872, characters: 135_549, inputTokens: 1_126_884 },
    ];

    for (const row of measured) {
        it(`never under-estimates ${row.name}`, () => {
            const perSegment = Math.round(row.characters / row.units);
            const estimate = estimateSearchInputTokens(packBatches(segmentsOf(row.units, perSegment)));

            expect(estimate).toBeGreaterThanOrEqual(row.inputTokens);
            // And not so generous that the budget becomes meaningless.
            expect(estimate).toBeLessThan(row.inputTokens * 3);
        });
    }

    it("charges a batch for the context in its state, not only for the text", () => {
        const withContext = estimateBatchInputTokens(packBatches(segmentsOf(4, 400))[0]);
        const without = estimateBatchInputTokens(packBatches(segmentsOf(4, 400, false))[0]);

        expect(withContext).toBeGreaterThan(without);
    });
});

describe("the provider budget", () => {
    const search = (id: string) => ({ id, inputTokens: 1_546_000, requests: 500 });

    /**
     * The measurement this gate exists for.
     *
     * §14.20 recorded a capped search running at 222k provider tokens a second against a published
     * 250k. One fits and two do not — and the budget is what makes that true in code rather than
     * in a paragraph.
     */
    it("admits one search at the segment cap and refuses the second", () => {
        const state = emptyBudget();

        expect(reserve(state, search("first"), 0)).toEqual({ ok: true });

        const second = reserve(state, search("second"), 0);
        expect(second.ok).toBe(false);
        if (!second.ok) {
            expect(second.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(second.retryAfterSeconds).toBeLessThanOrEqual(LIMITS.searchDeadlineMs / 1_000);
        }
    });

    it("recovers when a reservation expires, without anyone releasing it", () => {
        // A Worker that dies mid-search, or a reader that closed the tab, must not hold budget.
        const state = emptyBudget();
        expect(reserve(state, search("abandoned"), 0)).toEqual({ ok: true });

        expect(reserve(state, search("later"), LIMITS.searchDeadlineMs + 1)).toEqual({ ok: true });
    });

    it("recovers immediately on release, and releasing twice is harmless", () => {
        const state = emptyBudget();
        reserve(state, search("first"), 0);

        release(state, "first");
        release(state, "first");
        release(state, "never-existed");

        expect(reserve(state, search("second"), 0)).toEqual({ ok: true });
    });

    it("refuses on the request budget even when the tokens would fit", () => {
        // A document of many tiny segments is cheap in tokens and expensive in requests. The two
        // budgets are separate because a document can exhaust either one alone.
        const state = emptyBudget();
        const tiny = { id: "tiny", inputTokens: 1, requests: PROVIDER_BUDGET.requestsPerWindow };

        expect(reserve(state, tiny, 0)).toEqual({ ok: true });
        expect(reserve(state, { id: "next", inputTokens: 1, requests: 1 }, 0).ok).toBe(false);
    });

    it("sizes the budget so a capped search fits and two do not", () => {
        // Pinned to the arithmetic rather than to a number someone liked: if the deadline or the
        // published rate changes, this is what says whether the budget still means what it says.
        const capped = 500 * 3_092;

        expect(capped).toBeLessThanOrEqual(PROVIDER_BUDGET.inputTokens);
        expect(capped * 2).toBeGreaterThan(PROVIDER_BUDGET.inputTokens);
    });
});

describe("the declared subrequest allowance", () => {
    it("covers a search at the segment cap with its one retry", () => {
        // A deployment contract, not a tuning knob: if `maxSegmentCount` rises without this, a
        // reader's search dies partway through against a platform limit.
        const batches = Math.ceil(LIMITS.maxSegmentCount / LIMITS.maxSegmentsPerBatch);

        expect(batches * 2).toBeLessThanOrEqual(LIMITS.declaredSubrequestAllowance);
    });
});
