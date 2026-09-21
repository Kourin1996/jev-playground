/**
 * The quality harness's "is it finished yet" rule, against the real interface (spec §11.1).
 *
 * `hasSettled` reads the wording the results panel renders. The unit test pins the rule; this pins
 * the wording, which nothing else did — the two sentences it looks for were asserted only as
 * *absent* elsewhere, so rewording them would have made the harness start scoring provisional
 * rankings again with every test still green.
 *
 * The stream is driven from inside the page, because `route.fulfill` cannot hold a body open and
 * the whole point is the state that exists only while one is open.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSettled } from "./evaluation-state";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sample-contract-ja.pdf");

test.describe("the harness waits for a committed verdict", () => {
    test.skip(() => !existsSync(FIXTURE), "run `npm run fixtures:sample` first");

    /**
     * Replaces `fetch` for `/api/search` with one that answers in two instalments, and exposes a
     * hook to release the second. Installed before any script runs, so the application's own
     * client is the thing being driven.
     */
    const installControlledStream = async (page: Page) => {
        await page.addInitScript(() => {
            const realFetch = window.fetch.bind(window);
            let release: (() => void) | null = null;
            (window as unknown as { releaseFinalLine: () => void }).releaseFinalLine = () => release?.();

            window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                if (!url.includes("/api/search")) return realFetch(input, init);

                const body = JSON.parse(String(init?.body ?? "{}")) as { documentId: string; requestId: string; segments: { id: string }[] };
                const encoder = new TextEncoder();
                const line = (message: unknown) => encoder.encode(`${JSON.stringify(message)}\n`);

                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            line({
                                type: "progress",
                                documentId: body.documentId,
                                requestId: body.requestId,
                                evaluated: 1,
                                total: body.segments.length,
                                // A provisional, deliberately wrong, first passage.
                                results: [{ segmentId: body.segments[0].id, score: 1.1, relevantProbability: 0.4, confidence: 0.3 }],
                            }),
                        );

                        release = () => {
                            controller.enqueue(
                                line({
                                    type: "final",
                                    documentId: body.documentId,
                                    requestId: body.requestId,
                                    status: "matched",
                                    // The correct ranking, which is the only one that may be scored.
                                    results: [{ segmentId: body.segments[body.segments.length - 1].id, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                                    evaluatedSegmentCount: body.segments.length,
                                    requestCount: 2,
                                    model: "jev-1.13.0",
                                    elapsedMs: 120,
                                }),
                            );
                            controller.close();
                        };
                    },
                });

                return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
            };
        });
    };

    test("is not settled while the panel is still showing provisional results", async ({ page }) => {
        await installControlledStream(page);
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);

        await page.getByRole("radio", { name: "Meaning", exact: true }).click();
        await page.getByLabel("Search query").fill("途中でやめたら、お金は戻る？");
        await page.getByRole("button", { name: "Search", exact: true }).click();

        // The provisional passage is on screen: a harness that read now would score this ranking.
        await expect(page.locator("ol li")).toHaveCount(1);
        const provisional = await page.locator("ol li span.line-clamp-4").first().innerText();

        expect(hasSettled(await page.evaluate(() => document.body.innerText))).toBe(false);

        await page.evaluate(() => (window as unknown as { releaseFinalLine: () => void }).releaseFinalLine());

        await expect.poll(async () => hasSettled(await page.evaluate(() => document.body.innerText))).toBe(true);

        // And what it settled on is the final ranking, not the provisional one.
        const settledText = await page.locator("ol li span.line-clamp-4").first().innerText();
        expect(settledText).not.toBe(provisional);
    });
});
