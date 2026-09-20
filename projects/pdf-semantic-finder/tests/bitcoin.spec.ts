/**
 * Viewer and search behaviour against a real-world, third-party English PDF.
 *
 * `tests/fixtures/bitcoin.pdf` covers what the generated Japanese sample cannot: Latin word
 * spacing, a producer this repository did not write, nine physical pages, and repeated phrases
 * spread across them. Everything here intercepts `/api/search`, so no part of the document is sent
 * to TypeSafe AI.
 */
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/bitcoin.pdf");

/** Facts about this specific document, used to catch extraction regressions. */
const PAGE_COUNT = 9;

test("the Bitcoin whitepaper fixture is present", () => {
    expect(existsSync(FIXTURE), `Fixture PDF missing: ${FIXTURE}`).toBe(true);
});

test.describe("real-world English document", () => {
    test.skip(() => !existsSync(FIXTURE), "bitcoin.pdf not present");

    const open = async (page: Page) => {
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 20);
    };

    const exactSearch = async (page: Page, query: string) => {
        await page.locator('label:has-text("Exact text")').click();
        await page.getByLabel("Search query").fill(query);
        await page.getByLabel("Search query").press("Enter");
        await page.waitForFunction(() => document.querySelectorAll("ol li").length > 0 || document.body.innerText.includes("No relevant passage"), null, {
            timeout: 15_000,
        });
    };

    /** The physical page the current highlight sits on. */
    const highlightedPage = async (page: Page) =>
        Number(
            await page
                .locator(".pdf-finder-highlight")
                .first()
                .evaluate((node) => node.closest(".pdf-finder-page")?.getAttribute("data-page-number")),
        );

    const highlightPosition = (page: Page) =>
        page
            .locator(".pdf-finder-highlight")
            .first()
            .evaluate((node) => {
                const pageBox = node.closest(".pdf-finder-page")!.getBoundingClientRect();
                const box = node.getBoundingClientRect();
                return {
                    left: (box.left - pageBox.left) / pageBox.width,
                    top: (box.top - pageBox.top) / pageBox.height,
                    pageWidth: pageBox.width,
                };
            });

    test("reports nine pages and stays within every declared limit", async ({ page }) => {
        await open(page);

        const footer = await page.locator("footer p").textContent();
        expect(footer).toContain(`${PAGE_COUNT} pages`);
        expect(footer).toMatch(/\d+ searchable segments/u);

        // Inside the limits, so search is offered rather than blocked.
        await expect(page.getByLabel("Search query")).toBeEnabled();
        await expect(page.getByText("Search is unavailable for this document")).toHaveCount(0);
    });

    /** The visible passage text of a result, with runs of whitespace collapsed for comparison. */
    const resultText = async (page: Page, index = 0) => (await page.locator("ol li").nth(index).innerText()).replace(/\s+/gu, " ");

    test("joins a wrapped sentence without fusing the words across the line break", async ({ page }) => {
        // "allow online" ends a line and "payments to be" starts the next. Latin text needs a
        // space there; CJK must not get one. Exact search cannot catch a failure here, because
        // normalization strips whitespace from both sides — so this asserts on the visible text.
        await open(page);
        await exactSearch(page, "allow online payments to be sent");

        await expect(page.locator("ol li")).not.toHaveCount(0);
        expect(await resultText(page)).toContain("allow online payments to be sent");
    });

    test("keeps an address and a URL intact across lines", async ({ page }) => {
        await open(page);
        await exactSearch(page, "satoshin@gmx.com");

        await expect(page.locator("ol li")).toHaveCount(1);
        // Two separate lines in the source; they must not run together as one token.
        expect(await resultText(page)).toContain("satoshin@gmx.com www.bitcoin.org");
    });

    test("finds every occurrence of a phrase that spans several pages", async ({ page }) => {
        await open(page);
        await exactSearch(page, "double-spending");

        // Four occurrences: three on page 1, one on page 8. Occurrences, not segments — an earlier
        // per-segment search collapsed the three on page 1 into one and under-reported the document.
        await expect(page.locator("ol li")).toHaveCount(4);
        // Read the badge element itself. The whole list item's text runs the badge straight into
        // the passage, so "Page 8" followed by "12. Conclusion" reads as "Page 812".
        const badges = await page.locator("ol li").evaluateAll((nodes) =>
            nodes.map((node) =>
                [...node.querySelectorAll("span")]
                    .map((span) => span.textContent?.trim() ?? "")
                    .find((text) => /^Page \d+$/u.test(text))
                    ?.replace("Page ", ""),
            ),
        );
        expect(badges).toEqual(["1", "1", "1", "8"]);
    });

    test("navigates to a result on a later physical page", async ({ page }) => {
        await open(page);
        await exactSearch(page, "double-spending");

        // The last occurrence is the one on page 8.
        await page.locator("ol li button").last().click();
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        expect(await highlightedPage(page)).toBe(8);
    });

    test("highlights the occurrence a result represents when a phrase repeats on one page", async ({ page }) => {
        await open(page);
        await exactSearch(page, "Merkle Tree");

        // Both occurrences are on page 4, so only the item indexes can tell them apart.
        await expect(page.locator("ol li")).toHaveCount(2);

        const first = await highlightPosition(page);
        expect(await highlightedPage(page)).toBe(4);

        await page.getByRole("button", { name: "Next" }).click();
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        const second = await highlightPosition(page);
        expect(await highlightedPage(page)).toBe(4);
        expect(Math.abs(second.top - first.top)).toBeGreaterThan(0.01);
    });

    test("keeps the highlight aligned at 100%, 125%, and 150% zoom", async ({ page }) => {
        await open(page);
        await exactSearch(page, "Merkle Tree");
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        const baseline = await highlightPosition(page);
        const spanCount = await page.locator(".pdf-finder-highlight").count();

        for (const zoom of ["125%", "150%"]) {
            await page.getByRole("button", { name: "Zoom in" }).click();
            await expect(page.locator("span.w-14")).toHaveText(zoom);
            await page.waitForTimeout(500);

            const zoomed = await highlightPosition(page);

            expect(await page.locator(".pdf-finder-highlight").count()).toBe(spanCount);
            expect(Math.abs(zoomed.left - baseline.left)).toBeLessThan(0.005);
            expect(Math.abs(zoomed.top - baseline.top)).toBeLessThan(0.005);
            expect(zoomed.pageWidth).toBeGreaterThan(baseline.pageWidth);
        }
    });

    test("reports no match for text the document does not contain", async ({ page }) => {
        await open(page);
        await exactSearch(page, "zzz-not-present-zzz");

        await expect(page.locator("ol li")).toHaveCount(0);
        await expect(page.getByText("No relevant passage was found")).toBeVisible();
    });

    test("resolves a meaning-search result on a later page back to its passage", async ({ page }) => {
        await open(page);

        // Take a real segment ID from a later page rather than inventing one.
        await page.getByRole("button", { name: "View extracted text" }).click();
        const target = await page.locator("article").evaluateAll((nodes) =>
            nodes
                .map((node) => node.querySelector("header")?.textContent?.match(/p(\d{3})-s\d{3}/u))
                .filter((match): match is RegExpMatchArray => match != null && Number(match[1]) >= 6)
                .map((match) => match[0])
                .at(0),
        );
        await page.getByRole("button", { name: "Hide extracted text" }).click();
        expect(target).toBeDefined();

        await page.route("**/api/search", async (route: Route) => {
            const body = JSON.parse(route.request().postData() ?? "{}") as { documentId: string; requestId: string };
            await route.fulfill({
                json: {
                    documentId: body.documentId,
                    requestId: body.requestId,
                    status: "matched",
                    results: [{ segmentId: target, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
                    evaluatedSegmentCount: 1,
                    model: "jev-1.13.0",
                    elapsedMs: 100,
                },
            });
        });

        await page.locator('label:has-text("Meaning")').click();
        await page.getByLabel("Search query").fill("how does the network agree on history");
        await page.getByRole("button", { name: "Search" }).click();

        await expect(page.locator("ol li")).toHaveCount(1);
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
        expect(await highlightedPage(page)).toBe(Number(target!.slice(1, 4)));
    });
});
