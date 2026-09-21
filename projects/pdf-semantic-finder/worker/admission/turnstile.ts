/**
 * The human-presence gate in front of `/api/search` (spec §9.3).
 *
 * **What this is for, and what it is not.** Cloudflare Turnstile raises the cost of calling this
 * endpoint from a script. It is not authentication and it does not make the endpoint private: a
 * real browser can be driven, and tokens can be farmed. The rate limit and the provider budget
 * remain the controls that bound spend; this one bounds the casual case, which is the one that
 * actually happens.
 *
 * Split the same way as `budget.ts` against `search-budget.ts`: everything decidable is a pure
 * function, and only the single fetch needs the runtime.
 *
 * Nothing here logs or returns the token, the visitor's address, or anything about the document.
 */

/** Cloudflare's verification endpoint (Turnstile server-side validation). */
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type ChallengeVerdict =
    | { ok: true }
    /** The gate is configured and the caller did not clear it. */
    | { ok: false; reason: "missing_token" | "rejected" }
    /**
     * The gate could not be consulted — no secret configured, or Cloudflare did not answer.
     *
     * Kept distinct from a rejection so the caller decides the policy rather than this module
     * deciding it silently. `worker/index.ts` fails open on this and says so in the log, for the
     * same reason the rate limit does: a unit test and a `wrangler dev` without the secret must
     * still be able to run a search.
     */
    | { ok: false; reason: "unavailable" };

/** What `siteverify` is documented to return. Everything else on the object is ignored. */
export type SiteverifyResult = { success: boolean; errorCodes: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads Cloudflare's answer.
 *
 * Validated rather than cast, like every other response crossing a boundary into this Worker
 * (`call-jev.ts`'s `parseAnswers` does the same). A body that is not the documented shape is not
 * a failed challenge — it is an unusable answer, and `null` says so.
 */
export const parseSiteverifyResult = (payload: unknown): SiteverifyResult | null => {
    if (!isRecord(payload)) return null;
    if (typeof payload.success !== "boolean") return null;

    const raw = payload["error-codes"];
    const errorCodes = Array.isArray(raw) ? raw.filter((code): code is string => typeof code === "string") : [];

    return { success: payload.success, errorCodes };
};

export type VerifyOptions = {
    /** Injected so the unit tests drive this without the network. */
    fetchImpl?: typeof fetch;
    /** A fresh UUID makes a retried verification safe; Cloudflare dedupes on it. */
    idempotencyKey?: string;
    signal?: AbortSignal;
};

/**
 * Verifies one token.
 *
 * A token is valid for five minutes and **once**; a replay comes back as `timeout-or-duplicate`.
 * That is why the client obtains a fresh one per search rather than holding one for the session.
 */
export const verifyChallengeToken = async (
    token: string | null,
    secret: string | undefined,
    { fetchImpl = fetch, idempotencyKey, signal }: VerifyOptions = {},
): Promise<ChallengeVerdict> => {
    if (secret === undefined || secret === "") return { ok: false, reason: "unavailable" };
    if (token === null || token === "") return { ok: false, reason: "missing_token" };

    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (idempotencyKey !== undefined) form.append("idempotency_key", idempotencyKey);

    let payload: unknown;
    try {
        const response = await fetchImpl(SITEVERIFY_URL, { method: "POST", body: form, signal });
        if (!response.ok) return { ok: false, reason: "unavailable" };
        payload = await response.json();
    } catch {
        // An outage of the gate must not become a permanent outage of the product.
        return { ok: false, reason: "unavailable" };
    }

    const result = parseSiteverifyResult(payload);
    if (result === null) return { ok: false, reason: "unavailable" };

    return result.success ? { ok: true } : { ok: false, reason: "rejected" };
};
