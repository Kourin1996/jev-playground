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

export default defineConfig({
    testDir: "./tests",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    reporter: [["list"]],
    use: {
        baseURL: BASE_URL,
        viewport: { width: 1440, height: 900 },
    },
    webServer: {
        command: `npm run dev -- --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
    },
});
