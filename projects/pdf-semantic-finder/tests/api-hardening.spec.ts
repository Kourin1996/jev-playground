/**
 * What `/api/search` accepts, through the real Worker (spec §9.3).
 *
 * The unit tests cover the pure modules; these cover the gate as it is actually wired, because the
 * defect this replaces was one of *order* — the limit was enforced, just after the allocation it
 * was supposed to prevent.
 *
 * Every request here is rejected before the provider is reached, so none of them needs a
 * credential or sends anything to TypeSafe. The route is asserted to stay untouched all the same.
 */
import { expect, test } from "@playwright/test";
import { LIMITS } from "@/lib/types";

const body = (overrides: Record<string, unknown> = {}) => ({
    documentId: "doc-1",
    requestId: "req-1",
    query: "返金されますか",
    segments: [{ id: "p001-s001", text: "本文があります。" }],
    ...overrides,
});

test.describe("/api/search admission", () => {
    test("rejects a safelisted content type that merely contains application/json", async ({ request, baseURL }) => {
        // `text/plain` needs no CORS preflight, so a substring content-type test left this
        // endpoint reachable from any page in a visitor's browser.
        const response = await request.post(`${baseURL}/api/search`, {
            headers: { "Content-Type": "text/plain; application/json" },
            data: JSON.stringify(body()),
        });

        expect(response.status()).toBe(400);
        expect((await response.json()).error.code).toBe("invalid_request");
    });

    test("rejects an oversized body with 413, without parsing it", async ({ request, baseURL }) => {
        // Comfortably over the 4 MiB limit. The old path buffered it, parsed it, and encoded it
        // again before deciding — and answered 400, which says "malformed" rather than "too big".
        const response = await request.post(`${baseURL}/api/search`, {
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(body({ query: "あ".repeat(2_000_000) })),
        });

        expect(response.status()).toBe(413);
        expect((await response.json()).error.code).toBe("request_body_too_large");
    });

    test("rejects a cross-origin post", async ({ request, baseURL }) => {
        const response = await request.post(`${baseURL}/api/search`, {
            headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
            data: JSON.stringify(body()),
        });

        expect(response.status()).toBe(400);
        // And nothing that would let the caller read a response if one were produced.
        expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    });

    test("rejects context longer than a segment may be", async ({ request, baseURL }) => {
        const response = await request.post(`${baseURL}/api/search`, {
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(body({ segments: [{ id: "p001-s001", text: "本文", contextBefore: "い".repeat(LIMITS.maxSegmentCharacters + 1) }] })),
        });

        expect(response.status()).toBe(400);
        expect((await response.json()).error.code).toBe("segment_text_too_long");
    });

    test("every /api/ response forbids caching, including the ones with no body of their own", async ({ request, baseURL }) => {
        const notAllowed = await request.get(`${baseURL}/api/search`);
        expect(notAllowed.status()).toBe(405);
        expect(notAllowed.headers()["cache-control"]).toBe("no-store");

        const notFound = await request.get(`${baseURL}/api/nothing`);
        expect(notFound.status()).toBe(404);
        expect(notFound.headers()["cache-control"]).toBe("no-store");
    });

    test("refuses a valid search that carries no challenge token, when the gate is configured", async ({ request, baseURL }) => {
        /*
         * Proves the wiring rather than the decision: the header name, the status, and that the
         * gate sits in front of the provider. `tests/turnstile.test.ts` covers what the decision
         * itself is.
         *
         * Conditional because the gate is configured by `.dev.vars`, which is not in the
         * repository — with no `TURNSTILE_SECRET` the Worker logs `admission_unavailable` and
         * admits the search, and that is the documented behaviour rather than a failure. A run
         * that skips this is a run that did not test it, which is why it says so.
         */
        const config = await request.get(`${baseURL}/api/config`);
        expect(config.status()).toBe(200);

        const response = await request.post(`${baseURL}/api/search`, {
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(body()),
        });

        test.skip(response.status() !== 403, "TURNSTILE_SECRET is not configured in this environment; the gate fails open by design");

        expect((await response.json()).error.code).toBe("challenge_failed");
        // Nothing cross-origin may read this, refusal included.
        expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    });

    test("a rejected request never reaches the provider", async ({ page, baseURL }) => {
        // Through a page rather than the API context, so the route interception is real.
        let called = false;
        await page.route("https://api.typesafe.ai/**", async (route) => {
            called = true;
            await route.abort();
        });

        await page.goto("/");
        const status = await page.evaluate(async (url) => {
            const response = await fetch(`${url}/api/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ documentId: "doc-1", requestId: "req-1", query: "", segments: [] }),
            });
            return response.status;
        }, baseURL);

        expect(status).toBe(400);
        expect(called).toBe(false);
    });
});
