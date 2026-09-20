import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:5173",
        viewport: { width: 1440, height: 900 },
    },
    webServer: {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 120_000,
    },
});
