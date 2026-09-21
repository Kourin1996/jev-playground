import { defineConfig } from "@playwright/test";

/**
 * The port the suite drives.
 *
 * Overridable because 5173 is Vite's default and another project on the same machine will take it,
 * at which point every test here drives someone else's application and fails for reasons that have
 * nothing to do with this repository.
 */
const PORT = process.env.PDF_FINDER_PORT ?? "5173";
const BASE_URL = `http://localhost:${PORT}`;

/**
 * A second server, running the built output the way Cloudflare will.
 *
 * The dev server models neither Cloudflare's asset routing nor `public/_headers`, and a production
 * Content-Security-Policy would break Vite's own inline scripts and websocket. So the header spec
 * runs against `wrangler dev` on the build, which is the only place the deployed behaviour exists
 * before it is deployed.
 */
const PREVIEW_PORT = process.env.PDF_FINDER_PREVIEW_PORT ?? "8787";
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

export default defineConfig({
    testDir: "./tests",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
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
            reuseExistingServer: true,
            timeout: 120_000,
        },
        {
            command: `npm run build && npx wrangler dev --port ${PREVIEW_PORT} --inspector-port 0`,
            url: PREVIEW_URL,
            reuseExistingServer: true,
            timeout: 180_000,
        },
    ],
});
