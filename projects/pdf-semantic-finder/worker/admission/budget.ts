/**
 * The shared provider budget (spec §9.3).
 *
 * Pure arithmetic, so it is unit testable; `SearchBudget` in `worker/admission/search-budget.ts` is
 * a thin shell that holds one of these and serialises access to it.
 *
 * **Why this exists at all.** `docs/spec.md` §14.20 measured a search at the segment cap running at
 * 222,000 provider tokens a second against a published budget of 250,000. One such search fits and
 * two do not. A per-client rate limit cannot see that: it counts requests, and it counts them
 * before the body exists, so it cannot tell a four-segment search from a two-thousand-segment one.
 * This is the gate that can.
 *
 * It holds counters and opaque reservation IDs. No query, no passage, no document identifier ever
 * reaches it (spec §10).
 */
import { LIMITS } from "@/lib/types";

/**
 * What the provider account may have in flight at once.
 *
 * Taken at 80% of the published rates, over the one search deadline, because the published figures
 * move without notice and a budget sitting exactly on them has no margin for the retries §6.4
 * allows.
 */
export const PROVIDER_BUDGET = {
    /** `0.8 × 250,000 tokens/s × 15 s`. A capped search estimates about 1.55M, so one fits, two do not. */
    inputTokens: 0.8 * 250_000 * (LIMITS.searchDeadlineMs / 1_000),
    /** `0.8 × 1,200 requests/minute`, against 500 for a capped search. */
    requestsPerWindow: 0.8 * 1_200,
} as const;

export type Reservation = {
    id: string;
    inputTokens: number;
    requests: number;
    /** A crashed or disconnected invocation must not hold budget forever. */
    expiresAt: number;
};

export type BudgetState = { live: Reservation[] };

export type ReserveOutcome = { ok: true } | { ok: false; retryAfterSeconds: number };

export const emptyBudget = (): BudgetState => ({ live: [] });

const dropExpired = (state: BudgetState, now: number): void => {
    state.live = state.live.filter((reservation) => reservation.expiresAt > now);
};

/**
 * Admits a search, or says how long to wait.
 *
 * Both budgets have to hold: a document of many tiny segments is cheap in tokens and expensive in
 * requests, and one of thousands of full-size segments is the other way round.
 */
export const reserve = (state: BudgetState, want: { id: string; inputTokens: number; requests: number }, now: number): ReserveOutcome => {
    dropExpired(state, now);

    const heldTokens = state.live.reduce((total, reservation) => total + reservation.inputTokens, 0);
    const heldRequests = state.live.reduce((total, reservation) => total + reservation.requests, 0);

    if (heldTokens + want.inputTokens > PROVIDER_BUDGET.inputTokens || heldRequests + want.requests > PROVIDER_BUDGET.requestsPerWindow) {
        // Wait for the reservation that frees soonest, never longer than one search deadline —
        // by then every live reservation has expired anyway.
        const earliest = state.live.reduce((soonest, reservation) => Math.min(soonest, reservation.expiresAt), Number.POSITIVE_INFINITY);
        const waitMs = Number.isFinite(earliest) ? earliest - now : LIMITS.searchDeadlineMs;
        return { ok: false, retryAfterSeconds: Math.min(Math.max(1, Math.ceil(waitMs / 1_000)), Math.ceil(LIMITS.searchDeadlineMs / 1_000)) };
    }

    state.live.push({ id: want.id, inputTokens: want.inputTokens, requests: want.requests, expiresAt: now + LIMITS.searchDeadlineMs });
    return { ok: true };
};

/** Idempotent: releasing an unknown or already-expired reservation is not an error. */
export const release = (state: BudgetState, id: string): void => {
    state.live = state.live.filter((reservation) => reservation.id !== id);
};
