/**
 * Exact text search (spec §6.1).
 *
 * Runs entirely in the browser, makes no network call of any kind, and never falls back to meaning
 * search. Deterministic: the query and the page text go through the same normalization.
 *
 * Searching is done over each page's continuous text rather than over segments. Segments exist to
 * be evaluated by Jev; using them here would miss any phrase that straddles two of them, which is
 * text the document plainly contains.
 */
import { normalizeForSearch } from "@/lib/pdf/build-segments";
import { findMatchesOnPage } from "@/lib/pdf/page-index";
import type { PageIndex } from "@/lib/pdf/page-index";
import type { SearchHit } from "@/lib/types";

export type ExactSearchOutcome = { ok: false; reason: "empty_query" } | { ok: true; hits: SearchHit[] };

/**
 * Returns every occurrence, ordered by physical page and then by position on the page.
 *
 * All occurrences are returned: spec §6.1 places no cap on exact search, and hiding matches behind
 * an unstated limit would misreport what the document contains.
 */
export const exactSearch = (pages: readonly PageIndex[], query: string): ExactSearchOutcome => {
    const normalizedQuery = normalizeForSearch(query);

    // An empty query is invalid rather than a match-everything search. Checked after normalization,
    // so whitespace and zero-width characters alone are rejected too.
    if (normalizedQuery === "") return { ok: false, reason: "empty_query" };

    const hits = pages.flatMap((page) =>
        findMatchesOnPage(page, normalizedQuery).map((match): SearchHit => ({
            key: `p${String(match.pageNumber).padStart(3, "0")}-o${String(match.searchStart).padStart(6, "0")}`,
            pageNumber: match.pageNumber,
            ranges: match.ranges,
            previewText: match.previewText,
        })),
    );

    return { ok: true, hits };
};
