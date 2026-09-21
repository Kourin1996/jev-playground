/**
 * The human-presence gate's decision (spec §9.3).
 *
 * What matters here is which of three answers a search gets, because they are not
 * interchangeable: a rejection refuses the search, an unavailable gate lets it through and says so,
 * and anything Cloudflare returns that is not the documented shape is unavailable rather than a
 * rejection. Reading a malformed body as a failed challenge would turn an outage at Cloudflare
 * into a product that refuses everyone.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SITEVERIFY_URL, parseSiteverifyResult, verifyChallengeToken } from "../worker/admission/turnstile";

const answering = (body: unknown, ok = true) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "Content-Type": "application/json" } }));

describe("parseSiteverifyResult", () => {
    it("reads the documented shape", () => {
        expect(parseSiteverifyResult({ success: true })).toEqual({ success: true, errorCodes: [] });
        expect(parseSiteverifyResult({ success: false, "error-codes": ["timeout-or-duplicate"] })).toEqual({
            success: false,
            errorCodes: ["timeout-or-duplicate"],
        });
    });

    it("refuses anything else rather than guessing", () => {
        for (const payload of [null, undefined, "success", 1, [], {}, { success: "true" }]) {
            expect(parseSiteverifyResult(payload), JSON.stringify(payload) ?? "undefined").toBeNull();
        }
    });

    it("ignores error codes that are not strings instead of failing the parse", () => {
        expect(parseSiteverifyResult({ success: false, "error-codes": ["bad", 7, null] })).toEqual({ success: false, errorCodes: ["bad"] });
    });
});

describe("verifyChallengeToken", () => {
    it("admits a token Cloudflare accepts, and sends what the API documents", async () => {
        const fetchImpl = answering({ success: true });

        await expect(verifyChallengeToken("tok", "secret", { fetchImpl, idempotencyKey: "id-1" })).resolves.toEqual({ ok: true });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(SITEVERIFY_URL);
        expect(init.method).toBe("POST");
        const form = init.body as FormData;
        expect(form.get("secret")).toBe("secret");
        expect(form.get("response")).toBe("tok");
        expect(form.get("idempotency_key")).toBe("id-1");
    });

    it("refuses a token Cloudflare rejects", async () => {
        await expect(
            verifyChallengeToken("tok", "secret", { fetchImpl: answering({ success: false, "error-codes": ["invalid-input-response"] }) }),
        ).resolves.toEqual({ ok: false, reason: "rejected" });
    });

    it("refuses a replayed token, which is what `timeout-or-duplicate` means", async () => {
        // A Turnstile token is valid once. The client obtains a fresh one per search precisely
        // because of this, so a replay reaching here is not an ordinary case.
        await expect(
            verifyChallengeToken("tok", "secret", { fetchImpl: answering({ success: false, "error-codes": ["timeout-or-duplicate"] }) }),
        ).resolves.toEqual({ ok: false, reason: "rejected" });
    });

    it("says the caller sent no token, which is not the same as being rejected", async () => {
        const fetchImpl = answering({ success: true });
        await expect(verifyChallengeToken(null, "secret", { fetchImpl })).resolves.toEqual({ ok: false, reason: "missing_token" });
        await expect(verifyChallengeToken("", "secret", { fetchImpl })).resolves.toEqual({ ok: false, reason: "missing_token" });
        // Neither spent a round trip on Cloudflare.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reports an unconfigured gate as unavailable, and asks Cloudflare nothing", async () => {
        const fetchImpl = answering({ success: true });
        await expect(verifyChallengeToken("tok", undefined, { fetchImpl })).resolves.toEqual({ ok: false, reason: "unavailable" });
        await expect(verifyChallengeToken("tok", "", { fetchImpl })).resolves.toEqual({ ok: false, reason: "unavailable" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("treats an outage as unavailable rather than as a failed challenge", async () => {
        // The distinction is the whole point: refusing every search because Cloudflare is down
        // would be a worse outcome than admitting them unverified, and the caller decides which.
        await expect(verifyChallengeToken("tok", "secret", { fetchImpl: answering({ success: true }, false) })).resolves.toEqual({
            ok: false,
            reason: "unavailable",
        });

        const throwing = vi.fn(async () => {
            throw new TypeError("network");
        });
        await expect(verifyChallengeToken("tok", "secret", { fetchImpl: throwing })).resolves.toEqual({ ok: false, reason: "unavailable" });
    });

    it("treats an undocumented body as unavailable, never as a rejection", async () => {
        await expect(verifyChallengeToken("tok", "secret", { fetchImpl: answering({ ok: "yes" }) })).resolves.toEqual({ ok: false, reason: "unavailable" });
    });
});

describe("the deployment declares the widget", () => {
    /*
     * A regression pin for a failure that reached production.
     *
     * The sitekey was set as a plain-text variable in the Cloudflare dashboard, which looked
     * correct and then disappeared on the next `wrangler deploy` — that file is the source of
     * truth for `vars`, and what is not in it is not deployed. Secrets are stored separately and
     * survived, so the Worker kept demanding a token while `/api/config` answered `null` and the
     * client had none to send. Every search came back `challenge_failed`.
     *
     * Reading the file rather than the parsed config on purpose: what matters is that the value is
     * committed, which is the property that was missing.
     */
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const declared = /"VITE_TURNSTILE_SITEKEY"\s*:\s*"([^"]*)"/u.exec(config)?.[1];

    it("commits the sitekey, because a dashboard variable does not survive a deploy", () => {
        expect(declared, "wrangler.jsonc declares no VITE_TURNSTILE_SITEKEY").toBeDefined();
        expect(declared).not.toBe("");
    });

    it("is not one of Cloudflare's test keys, which would ship a widget that always passes", () => {
        // `1x…`, `2x…` and `3x…` are the documented dummy sitekeys. They belong in `.dev.vars`,
        // never in the deployed configuration, where they would make the gate decorative.
        expect(declared?.slice(0, 2), `test sitekey in wrangler.jsonc: ${declared}`).not.toMatch(/^[123]x$/u);
    });
});
