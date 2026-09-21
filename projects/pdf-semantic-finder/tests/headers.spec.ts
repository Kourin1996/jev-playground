/**
 * Response headers as the deployment will actually send them (spec §10).
 *
 * Runs against `wrangler dev` on the build, not the dev server: the dev server models neither
 * Cloudflare's asset routing nor `public/_headers`, and a production Content-Security-Policy would
 * break Vite's own inline scripts and websocket. Everything asserted here is therefore the
 * deployed behaviour, which is the only version of it worth asserting.
 *
 * The important test is the last one. A policy that is merely *present* proves nothing; a policy
 * that survives opening a PDF, zooming it and searching it is one that can be deployed.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sample-contract-ja.pdf");

/** Everything that must be on every response a browser sees. */
const REQUIRED = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
};

test.describe("deployed response headers", () => {
    test("the page carries the policy, and the policy says what it should", async ({ request, baseURL }) => {
        const response = await request.get(`${baseURL}/`);
        expect(response.status()).toBe(200);

        const headers = response.headers();
        for (const [name, value] of Object.entries(REQUIRED)) expect(headers[name], name).toBe(value);

        const csp = headers["content-security-policy"];
        expect(csp).toBeDefined();
        // The clauses this application depends on, each for a reason recorded in security-headers.ts.
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("'wasm-unsafe-eval'");
        expect(csp).toContain("worker-src 'self' blob:");
        // Turnstile (spec §9.3) loads its script from this host and runs the widget in an iframe
        // from it. `frame-src` must be named: without it the directive falls back to
        // `default-src 'self'` and the widget is blocked.
        expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com");
        expect(csp).toContain("frame-src https://challenges.cloudflare.com");
        // The browser never contacts the provider; the Worker does. A provider host appearing here
        // would mean something had moved to the wrong side of the architecture boundary.
        expect(csp).toContain("connect-src 'self'");
        expect(csp).not.toContain("typesafe.ai");
    });

    test("a hashed asset carries it too, not just the entry page", async ({ request, baseURL }) => {
        // These are served by Cloudflare's asset router without invoking the Worker, so they are
        // covered by `public/_headers` rather than by the code. That is exactly why it is checked.
        const page = await request.get(`${baseURL}/`);
        const script = /src="(\/assets\/[^"]+\.js)"/u.exec(await page.text())?.[1];
        expect(script, "no hashed script found in the built page").toBeDefined();

        const asset = await request.get(`${baseURL}${script}`);
        expect(asset.status()).toBe(200);
        expect(asset.headers()["content-security-policy"]).toBeDefined();
        expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
    });

    test("every /api/ response forbids caching and sends no CORS grant", async ({ request, baseURL }) => {
        const notAllowed = await request.get(`${baseURL}/api/search`);
        expect(notAllowed.status()).toBe(405);
        expect(notAllowed.headers()["cache-control"]).toBe("no-store");
        expect(notAllowed.headers()["access-control-allow-origin"]).toBeUndefined();

        const notFound = await request.get(`${baseURL}/api/nothing`);
        expect(notFound.status()).toBe(404);
        expect(notFound.headers()["cache-control"]).toBe("no-store");
    });

    test("the policy survives opening, zooming and searching a real PDF", async ({ page }) => {
        test.skip(!existsSync(FIXTURE), "run `npm run fixtures:sample` first");

        // A violation is reported to the console and nowhere else, so the console is the assertion.
        const violations: string[] = [];
        const record = (text: string) => {
            if (/Content Security Policy|Refused to/iu.test(text)) violations.push(text);
        };
        page.on("console", (message) => record(message.text()));
        page.on("pageerror", (error) => record(error.message));

        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        // The text layer existing at all means the PDF.js worker started and its WASM compiled —
        // the two things the policy is most likely to have broken.
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);

        await page.getByRole("button", { name: "Zoom in" }).click();
        await page.waitForTimeout(500);

        await page.getByRole("radio", { name: "Exact text", exact: true }).click();
        await page.getByLabel("Search query").fill("解約");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        expect(violations, violations.join("\n")).toEqual([]);
    });

    test("the only third parties the page contacts are the ones the policy names", async ({ page, baseURL }) => {
        // `style-src` and `font-src` name Google's hosts, and `connect-src` names nobody. A host
        // appearing here that the policy does not allow would be blocked in production and fall
        // back silently — a missing font, or a feature that quietly stops working.
        const own = new URL(baseURL!).host;
        const hosts = new Set<string>();
        page.on("request", (request) => {
            const { host } = new URL(request.url());
            if (host !== own) hosts.add(host);
        });

        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Turnstile is absent from this list on purpose: `challenges.cloudflare.com` is contacted
        // only when a meaning search runs, and nothing on this page load does. That it stays
        // absent is the assertion — a widget loaded at start-up would make opening a PDF cost a
        // third-party request, which §14.30's cost model says it does not.
        expect([...hosts].sort()).toEqual(["fonts.googleapis.com", "fonts.gstatic.com"]);
    });
});
