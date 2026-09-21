import { defineConfig } from "@playwright/test";

/**
 * The port the suite drives.
 *
 * Overridable because another project on the same machine may already use the default port. Keep
 * this project's default distinct, and never reuse an unrelated server as the test target.
 */
const PORT = process.env.PDF_FINDER_PORT ?? "5196";
const BASE_URL = `http://localhost:${PORT}`;

/**
 * A second server, running the built output the way Cloudflare will.
 *
 * The dev server models neither Cloudflare's asset routing nor `public/_headers`, and a production
 * Content-Security-Policy would break Vite's own inline scripts and websocket. So the header spec
 * runs against `wrangler dev` on the build, which is the only place the deployed behaviour exists
 * before it is deployed.
 */
const PREVIEW_PORT = process.env.PDF_FINDER_PREVIEW_PORT ?? "8876";
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

export default defineConfig({
    testDir: "./tests",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    /*
     * One retry on CI, and none locally.
     *
     * Not a general allowance for flaky tests. It covers one known race: both web servers come up
     * at once while the build runs, and on a cold runner a test occasionally times out waiting for
     * a dev server that is still busy. A real failure repeats, so a retry does not hide one — but a
     * run that needed a retry is worth looking at rather than waving through.
     */
    retries: process.env.CI ? 1 : 0,
    reporter: [["list"]],
    projects: [
        {
            name: "dev",
            testIgnore: "**/headers.spec.ts",
            use: { baseURL: BASE_URL, viewport: { width: 1440, height: 900 } },
        },
        {
            name: "preview",
            testMatch: "**/headers.spec.ts",
            use: { baseURL: PREVIEW_URL, viewport: { width: 1440, height: 900 } },
        },
    ],
    webServer: [
        {
            command: `npm run dev -- --port ${PORT} --strictPort`,
            url: BASE_URL,
            reuseExistingServer: false,
            timeout: 120_000,
        },
        {
            command: `npm run build && npx wrangler dev --port ${PREVIEW_PORT} --inspector-port 0`,
            url: PREVIEW_URL,
            reuseExistingServer: false,
            timeout: 180_000,
        },
    ],
});
