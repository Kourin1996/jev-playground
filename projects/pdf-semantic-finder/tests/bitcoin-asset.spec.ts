/**
 * Behaviour that has to hold on a real third-party document, exercised against `assets/bitcoin.pdf`.
 *
 * `tests/bitcoin.spec.ts` covers extraction and highlighting on the same PDF. This file covers what
 * changed around it: the search units segmentation now produces, the drop zone as an affordance,
 * and the judgement the extracted-text view reports. Every semantic search here is intercepted, so
 * nothing from the document reaches TypeSafe AI.
 */
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "../src/lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../assets/bitcoin.pdf");

/**
 * Measured on this exact document, not a round number.
 *
 * It moves when the boundary rules move, and that is the point: the number is here so a change to
 * segmentation has to be acknowledged rather than noticed later. Before the capacity floor was
 * removed this was 61; 110 while the fragment rule went by length alone; and 112 before a
 * figure's labels stopped deciding what the body font size was.
 */
const SEGMENT_COUNT = 86;

test("the Bitcoin whitepaper asset is present", () => {
    expect(existsSync(FIXTURE), `Missing: ${FIXTURE}`).toBe(true);
});

test.describe("assets/bitcoin.pdf", () => {
    test.skip(() => !existsSync(FIXTURE), "assets/bitcoin.pdf not present");

    const open = async (page: Page) => {
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 20);
    };

    const exactSearch = async (page: Page, query: string) => {
        await page.getByRole("radio", { name: "Exact text" }).click();
        await page.getByLabel("Search query").fill(query);
        await page.getByLabel("Search query").press("Enter");
        await page.waitForFunction(
            () => document.querySelectorAll("ol li").length > 0 || /No matching text was found|met the relevance threshold/u.test(document.body.innerText),
            null,
            {
                timeout: 15_000,
            },
        );
    };

    test("segments the document into units of the size the limits are derived from", async ({ page }) => {
        await open(page);

        await expect(page.locator("footer p")).toContainText(`${SEGMENT_COUNT} searchable segments`);
        await expect(page.locator("header p")).toContainText("9 pages");

        await page.getByRole("button", { name: "View extracted text" }).click();
        const texts = await page.locator("article > p").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
        const lengths = texts.map((text) => [...text].length);

        expect(lengths).toHaveLength(SEGMENT_COUNT);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(LIMITS.maxSegmentCharacters);
        expect(lengths.length).toBeLessThanOrEqual(LIMITS.maxSegmentCount);

        // There is deliberately no minimum length, and "ends a sentence" is not the property worth
        // asserting either — `第5条　返金不可` ends no sentence and is exactly the passage a reader
        // wants. What must not survive is a unit that answers nothing, so the invariant is that
        // anything below the fragment threshold is either a provision or a complete sentence.
        const provision = /^\s*(?:[-–—•·*・･]|[（(]\s*[0-9０-９]+\s*[）)]|第\s*[0-9０-９一二三四五六七八九十百]+\s*[条項号]|[①-⑳])/u;
        const answersNothing = texts.filter(
            (text) => [...text].length < LIMITS.minSegmentCharacters && !/[。．.!?！？]\s*$/u.test(text) && !provision.test(text),
        );
        expect(answersNothing, "a fragment that answers nothing survived merging").toEqual([]);
    });

    test("finds every occurrence of phrases the document repeats", async ({ page }) => {
        await open(page);

        // Occurrence counts, not segment counts: they are a property of the text and must not move
        // when the segmentation does.
        await exactSearch(page, "double-spending");
        await expect(page.locator("ol li")).toHaveCount(4);

        await exactSearch(page, "proof-of-work");
        await expect(page.locator("ol li")).toHaveCount(20);
    });

    test("says what an empty result means, differently for each mode", async ({ page }) => {
        await open(page);
        await exactSearch(page, "zzz-not-present-zzz");

        // Exact search found no such characters. That is a literal absence.
        await expect(page.getByText("No matching text was found")).toBeVisible();
        await expect(page.getByText("met the relevance threshold")).toHaveCount(0);

        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: unknown[] };
            await route.fulfill({
                contentType: "application/x-ndjson",
                body:
                    JSON.stringify({
                        type: "final",
                        documentId: body.documentId,
                        requestId: body.requestId,
                        status: "no_match",
                        results: [],
                        evaluatedSegmentCount: body.segments.length,
                        requestCount: 1,
                        model: "jev-1.13.0",
                        elapsedMs: 1,
                    }) + "\n",
            });
        });

        await page.getByRole("radio", { name: "Meaning" }).click();
        await page.getByLabel("Search query").fill("what colour is the moon");
        await page.getByRole("button", { name: "Search", exact: true }).click();

        // Meaning search evaluated everything and nothing cleared §7's threshold. That is a
        // judgement with a number behind it, and can be wrong in both directions.
        await expect(page.getByText("met the relevance threshold")).toBeVisible();
        await expect(page.getByText("No matching text was found")).toHaveCount(0);
        await expect(page.getByText("Text inside images was not searched")).toBeVisible();
    });

    test("marks only the matched characters, so two hits in one line are distinguishable", async ({ page }) => {
        await open(page);
        await exactSearch(page, "proof-of-work");

        const marked = await page.locator(".pdf-finder-highlight").evaluateAll((nodes) => nodes.map((node) => node.textContent).join(""));
        // The whole text item would drag in the surrounding sentence.
        expect(marked.replace(/\s+/gu, "")).toBe("proof-of-work");
    });

    test("locates every segment in the rendered page", async ({ page }) => {
        // A sweep rather than a sample: a mapping that fails on one segment in a hundred is the
        // failure mode this project refuses to paper over by re-searching for the text.
        await open(page);
        await page.getByRole("button", { name: "View extracted text" }).click();
        const ids = await page
            .locator("article header")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent?.match(/p\d{3}-s\d{3}/u)?.[0]).filter((id): id is string => id !== undefined));
        await page.getByRole("button", { name: "Hide extracted text" }).click();

        expect(ids).toHaveLength(SEGMENT_COUNT);

        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: Array<{ id: string }> };
            const wanted = new URL(route.request().url()).searchParams.get("segment") ?? body.segments[0].id;
            await route.fulfill({
                contentType: "application/x-ndjson",
                body:
                    JSON.stringify({
                        type: "final",
                        documentId: body.documentId,
                        requestId: body.requestId,
                        status: "matched",
                        results: [{ segmentId: wanted, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                        evaluatedSegmentCount: body.segments.length,
                        requestCount: 1,
                        model: "jev-1.13.0",
                        elapsedMs: 1,
                    }) + "\n",
            });
        });

        await page.getByRole("radio", { name: "Meaning" }).click();

        for (const id of ids) {
            await page.unroute("**/api/search");
            await page.route("**/api/search", async (route: Route) => {
                const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: { id: string }[] };
                await route.fulfill({
                    contentType: "application/x-ndjson",
                    body:
                        JSON.stringify({
                            type: "final",
                            documentId: body.documentId,
                            requestId: body.requestId,
                            status: "matched",
                            results: [{ segmentId: id, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                            evaluatedSegmentCount: body.segments.length,
                            requestCount: 1,
                            model: "jev-1.13.0",
                            elapsedMs: 1,
                        }) + "\n",
                });
            });

            await page.getByLabel("Search query").fill(`locate ${id}`);
            await page.getByRole("button", { name: "Search", exact: true }).click();

            await expect(page.locator(".pdf-finder-highlight").first(), `segment ${id} produced no highlight`).toBeVisible({ timeout: 10_000 });
            // A mapping failure is reported rather than guessed at, so the message must stay away.
            await expect(page.getByText("could not be located in the rendered page")).toHaveCount(0);

            // Read from the document, not through a resolved handle: the highlight span is torn
            // down and rebuilt whenever the text layer re-renders.
            await expect
                .poll(async () =>
                    page.evaluate(() => document.querySelector(".pdf-finder-highlight")?.closest(".pdf-finder-page")?.getAttribute("data-page-number") ?? null),
                )
                .toBe(String(Number(id.slice(1, 4))));
        }
    });

    test("shows what each passage was judged to be, including the ones no result names", async ({ page }) => {
        await open(page);

        let evaluatedCount = 0;
        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: Array<{ id: string }> };
            evaluatedCount = body.segments.length;
            await route.fulfill({
                contentType: "application/x-ndjson",
                body:
                    JSON.stringify({
                        type: "final",
                        documentId: body.documentId,
                        requestId: body.requestId,
                        status: "matched",
                        // One result, but a judgement for every segment: a descending ramp, so the
                        // second segment lands above the matched threshold and was still not returned.
                        results: [{ segmentId: body.segments[0].id, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                        evaluations: body.segments.map((segment, index) => ({
                            segmentId: segment.id,
                            score: 2 - index * 0.01,
                            relevantProbability: Math.max(0, 0.97 - index * 0.01),
                            confidence: 0.9,
                        })),
                        evaluatedSegmentCount: body.segments.length,
                        requestCount: 1,
                        model: "jev-1.13.0",
                        elapsedMs: 1,
                    }) + "\n",
            });
        });

        await page.getByRole("radio", { name: "Meaning" }).click();
        await page.getByLabel("Search query").fill("how does the network agree on history");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.locator("ol li")).toHaveCount(1);

        await page.getByRole("button", { name: "View extracted text" }).click();

        const articles = page.locator("article");
        await expect(articles).toHaveCount(evaluatedCount);
        // The returned segment, and the one right behind it that no result mentions.
        await expect(articles.nth(0)).toContainText("97%");
        await expect(articles.nth(1)).toContainText("96%");
        await expect(articles.nth(1)).toContainText("matched");
        // Far enough down the ramp to fall under both thresholds.
        await expect(articles.nth(80)).toContainText("below threshold");
        // What travelled with the passage is shown too, not only the passage.
        await expect(articles.nth(1).getByText("Context sent with this passage")).toBeVisible();
    });

    test("exposes the context a passage was judged with, and navigates to it", async ({ page }) => {
        // §6.3 lets the model use the neighbouring passages to resolve what the target refers to.
        // A reader who cannot reach those neighbours is worse off than the model was.
        await open(page);

        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: Array<{ id: string }> };
            // A segment in the middle of a page, so it has a neighbour on each side.
            const target = body.segments[5];
            await route.fulfill({
                contentType: "application/x-ndjson",
                body:
                    JSON.stringify({
                        type: "final",
                        documentId: body.documentId,
                        requestId: body.requestId,
                        status: "matched",
                        results: [{ segmentId: target.id, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                        evaluatedSegmentCount: body.segments.length,
                        requestCount: 1,
                        model: "jev-1.13.0",
                        elapsedMs: 1,
                    }) + "\n",
            });
        });

        await page.getByRole("radio", { name: "Meaning" }).click();
        await page.getByLabel("Search query").fill("what does this passage depend on");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.locator("ol li")).toHaveCount(1);

        const disclosure = page.getByText("Show surrounding text");
        await expect(disclosure).toBeVisible();
        // Named for what it is. The provider never reports which context it used.
        await expect(page.getByText("what Jev used")).toHaveCount(0);

        await disclosure.click();
        const before = page.locator("ol li button", { hasText: "before" });
        await expect(before).toBeVisible();
        const neighbourText = (await before.innerText())
            .replace(/^before\s*/u, "")
            .replace(/\s+/gu, " ")
            .slice(0, 24);

        await before.click();

        // It becomes a result of its own, without a second search.
        await expect(page.locator("ol li")).toHaveCount(2);
        await expect(page.locator("ol li").nth(1)).toContainText(neighbourText);
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
    });

    test("takes its results from a streamed response", async ({ page }) => {
        // The Worker answers with newline-delimited JSON — a progress line per batch and one final
        // line — so the reader sees passages while the rest are still being judged. Playwright
        // cannot fulfil a route with a stream, so this covers the protocol and the final state;
        // the provisional rendering is covered by `tests/search-client.test.ts` and by a real
        // measurement against the provider (docs/spec.md §14.21).
        await open(page);

        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string; segments: Array<{ id: string }> };
            const { documentId, requestId, segments } = body;
            const line = (message: unknown) => `${JSON.stringify(message)}\n`;

            await route.fulfill({
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
                body:
                    line({
                        type: "progress",
                        documentId,
                        requestId,
                        evaluated: 8,
                        total: segments.length,
                        results: [{ segmentId: segments[2].id, score: 1.4, relevantProbability: 0.44, confidence: 0.3 }],
                    }) +
                    line({
                        type: "final",
                        documentId,
                        requestId,
                        status: "matched",
                        results: [{ segmentId: segments[9].id, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                        evaluatedSegmentCount: segments.length,
                        requestCount: 1,
                        model: "jev-1.13.0",
                        elapsedMs: 5_000,
                    }),
            });
        });

        await page.getByRole("radio", { name: "Meaning" }).click();
        await page.getByLabel("Search query").fill("what does the network agree on");
        await page.getByRole("button", { name: "Search", exact: true }).click();

        // The final line wins: the provisional passage is replaced, not appended to.
        await expect(page.locator("ol li")).toHaveCount(1);
        await expect(page.locator("footer p")).toContainText("searched in");
        // And the provisional wording is gone once the search has finished.
        await expect(page.getByText("passages judged")).toHaveCount(0);
        await expect(page.getByText("may still change")).toHaveCount(0);
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
    });

    test("keeps the reader's place in the document while the extracted text is on screen", async ({ page }) => {
        // The highlight alone would not catch this: it is re-applied on a remount either way.
        // What a remount loses is the scroll position a result navigated to.
        await open(page);
        await exactSearch(page, "double-spending");
        await page.locator("ol li button").last().click();
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        const scroller = page.locator(".pdf-finder-page").first().locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
        // Navigation scrolls smoothly, so the value has to stop moving before it means anything.
        const settledScrollTop = async () => {
            let previous = -1;
            for (let attempt = 0; attempt < 40; attempt += 1) {
                const current = await scroller.evaluate((node) => node.scrollTop);
                if (current === previous && current > 0) return current;
                previous = current;
                await page.waitForTimeout(100);
            }
            return previous;
        };

        const scrolled = await settledScrollTop();
        expect(scrolled).toBeGreaterThan(100);

        await page.getByRole("button", { name: "View extracted text" }).click();
        await expect(page.locator("article").first()).toBeVisible();
        // The rendered pages are still there behind the panel, not torn down.
        expect(await page.locator(".pdf-finder-page").count()).toBe(9);

        await page.getByRole("button", { name: "Hide extracted text" }).click();
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
        expect(Math.abs((await settledScrollTop()) - scrolled)).toBeLessThan(10);
    });
});

test.describe("the drop zone before a document is open", () => {
    test.skip(() => !existsSync(FIXTURE), "assets/bitcoin.pdf not present");

    test("offers no second way to open a file until there is one open", async ({ page }) => {
        await page.goto("/");

        await expect(page.getByRole("button", { name: "Open PDF" })).toHaveCount(0);
        await expect(page.getByText("Open PDF")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "View extracted text" })).toHaveCount(0);

        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");

        await expect(page.getByText("Open PDF")).toBeVisible();
        await expect(page.getByRole("button", { name: "View extracted text" })).toBeVisible();
    });

    test("opens the file picker from anywhere in the box, not only from the words", async ({ page }) => {
        await page.goto("/");

        // Clicking a label activates the control it is bound to. Watching the input for that is
        // what separates "the whole box is clickable" from "the link inside it is".
        await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
            (window as unknown as { pickerOpened: number }).pickerOpened = 0;
            input.addEventListener("click", (event) => {
                event.preventDefault();
                (window as unknown as { pickerOpened: number }).pickerOpened += 1;
            });
        });

        const box = page.locator("[data-dropzone]");
        const bounds = (await box.boundingBox())!;
        // The top-left padding: no text, no icon, no control — just the box.
        await page.mouse.click(bounds.x + 8, bounds.y + 8);

        expect(await page.evaluate(() => (window as unknown as { pickerOpened: number }).pickerOpened)).toBe(1);
    });

    test("responds while a file is anywhere over the page, and swallows a drop outside the box", async ({ page }) => {
        await page.goto("/");
        const box = page.locator("[data-dropzone]");
        const ringAt = () => box.evaluate((node) => getComputedStyle(node).getPropertyValue("--tw-ring-shadow"));

        const atRest = await ringAt();

        // Dispatched on the header, well away from the box: the box still has to react.
        await page.evaluate(() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(["x"], "x.pdf", { type: "application/pdf" }));
            document.querySelector("header")!.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
        });

        await expect(box).toHaveClass(/ring-2/u);
        expect(await ringAt()).not.toBe(atRest);
        await expect(box).toContainText("Drop the file here");

        // A drop outside the box must not navigate the browser to the file.
        const before = page.url();
        await page.evaluate(() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(["x"], "x.pdf", { type: "application/pdf" }));
            document.querySelector("header")!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        });

        await expect(box).not.toContainText("Drop the file here");
        expect(page.url()).toBe(before);
    });
});
