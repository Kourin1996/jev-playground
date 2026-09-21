/**
 * Ranking and result classification (spec §7).
 *
 * Pure, and free of both PDF.js and Workers runtime types.
 */
import type { SearchErrorCode, SearchResultRecord, SearchStatus } from "@/lib/types";
import { LIMITS, THRESHOLDS } from "@/lib/types";
import type { RequestSegment } from "./build-jev-request";
import type { JevScoreAnswer } from "./validate";

export type RankOutcome =
    | {
          ok: true;
          status: SearchStatus;
          results: SearchResultRecord[];
          /** Every segment's judgement, in document order. See `SearchResponse.evaluations`. */
          evaluations: SearchResultRecord[];
          evaluatedSegmentCount: number;
      }
    | { ok: false; code: SearchErrorCode };

/**
 * Ranks evaluated segments and classifies the search.
 *
 * `segments` arrives in document order, which is exactly spec §7's "physical page and segment
 * order ascending" tie-break. `Array.prototype.sort` has been required to be stable since ES2019,
 * so equal keys keep that order without the Worker needing page numbers it is not sent — and
 * without parsing them back out of segment IDs, which would couple ranking to the ID grammar.
 */
export const rankResults = (segments: readonly RequestSegment[], answers: ReadonlyMap<string, JevScoreAnswer>): RankOutcome => {
    // Spec §7: any segment left unevaluated is a search error, never a report of no match.
    if (answers.size !== segments.length) return { ok: false, code: "incomplete_evaluation" };

    const scored = segments.map((segment) => {
        const answer = answers.get(segment.id);
        if (answer === undefined) return null;

        return {
            segmentId: segment.id,
            score: answer.score,
            relevantProbability: answer.probabilities["2"],
            confidence: answer.confidence,
        } satisfies SearchResultRecord;
    });

    if (scored.some((record) => record === null)) return { ok: false, code: "incomplete_evaluation" };

    const records = scored as SearchResultRecord[];

    const ranked = [...records].sort((a, b) => {
        if (b.relevantProbability !== a.relevantProbability) return b.relevantProbability - a.relevantProbability;
        // Jev's `score` is the probability-weighted position on the level number line, which is
        // spec §7's "weighted score".
        return b.score - a.score;
    });

    const qualifying = ranked.filter((record) => record.relevantProbability >= THRESHOLDS.matched);
    const nearMisses = ranked.filter((record) => record.relevantProbability >= THRESHOLDS.uncertain);

    /*
     * A passage below the matched threshold is not offered as a candidate.
     *
     * `uncertain` used to mean "show these three anyway, with a warning". That put a passage the
     * model was unsure about in the same list, in the same shape, as one it was confident of — and
     * a reader who follows a result to its page has already spent the time by the point the warning
     * matters. The state survives, because "nothing qualified but something was close" is worth
     * saying; what does not survive is presenting the near miss as an answer.
     *
     * The list is never padded with weaker results either.
     */
    const status: SearchStatus = qualifying.length > 0 ? "matched" : nearMisses.length > 0 ? "uncertain" : "no_match";

    return {
        ok: true,
        status,
        results: qualifying.slice(0, LIMITS.maxResults),
        // `records` follows `segments`, which arrives in document order; `ranked` is a sorted copy.
        evaluations: records,
        evaluatedSegmentCount: segments.length,
    };
};
