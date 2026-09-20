import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    // The Worker runs inside the dev server, so `/api/search` is same-origin in development and
    // in production without a proxy.
    plugins: [react(), tailwindcss(), cloudflare()],
    resolve: {
        alias: {
            "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src"),
        },
    },
    test: {
        // Playwright specs must not be collected by vitest: importing `@playwright/test` under
        // vitest fails in a way that is hard to read.
        include: ["tests/**/*.test.ts"],
        exclude: ["**/node_modules/**", "**/*.spec.ts"],
    },
});
