/**
 * Durable Object holding the account-wide provider budget (spec §9.3).
 *
 * A shell over `budget.ts`: one instance for the whole Worker, so the counters are actually shared
 * rather than per-isolate. Everything decidable is in the pure module, and this file only owns
 * serialisation and the request plumbing — the same split as `validate.ts` against `index.ts`.
 *
 * State lives in memory and is not persisted. Losing it on eviction over-admits for at most one
 * search deadline, which is a better trade than a storage write on the path of every search.
 */
import { DurableObject } from "cloudflare:workers";
import { emptyBudget, release, reserve } from "./budget";
import type { BudgetState, ReserveOutcome } from "./budget";

export class SearchBudget extends DurableObject {
    #state: BudgetState = emptyBudget();

    reserve(id: string, inputTokens: number, requests: number): ReserveOutcome {
        return reserve(this.#state, { id, inputTokens, requests }, Date.now());
    }

    release(id: string): void {
        release(this.#state, id);
    }
}
