/**
 * Exact search on a page carrying supplementary-plane characters, in a real browser (spec §8).
 *
 * `𠮟` is one code point and two UTF-16 units. `String.prototype.indexOf` and `.length` deal in
 * units, while every offset in the extraction is a code point, so one of these characters used to
 * shift every match after it on the page: the highlight landed on the wrong characters, and when
 * the converted index ran past the end of the offset array the result came back with no range and
 * an empty preview — for text the document plainly contains.
 *
 * The unit tests pin the arithmetic. This asserts what a reader actually sees, at the zoom levels
 * §11.2 requires, because a range that is right in the index and wrong on the page is still wrong.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sample-supplementary-ja.pdf");

test.describe("supplementary characters", () => {
    test.skip(() => !existsSync(FIXTURE), "run `npm run fixtures:sample` first");

    const open = async (page: Page) => {
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 3);
    };

    const search = async (page: Page, query: string) => {
        await page.getByRole("radio", { name: "Exact text" }).click();
        await page.getByLabel("Search query").fill(query);
        await page.getByRole("button", { name: "Search", exact: true }).click();
    };

    /** What is actually marked on the page, with the font's compatibility forms folded back. */
    const highlighted = async (page: Page) =>
        (await page.locator(".pdf-finder-highlight").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "").join(""))).normalize("NFKC");

    test("highlights the queried characters and not their neighbours", async ({ page }) => {
        await open(page);

        // 保管 sits in the second clause, after two 𠮟 on the same page — the position where a
        // unit-indexed offset pointed at the following characters instead.
        await search(page, "保管");
        await expect(page.locator("ol li")).toHaveCount(1);
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
        expect(await highlighted(page)).toBe("保管");
    });

    test("finds a supplementary character itself, in every occurrence", async ({ page }) => {
        await open(page);
        await search(page, "𠮟責");

        await expect(page.locator("ol li")).toHaveCount(3);
        expect(await highlighted(page)).toBe("𠮟責");
    });

    test("finds a phrase repeated after one, and stays on the selected occurrence", async ({ page }) => {
        await open(page);
        await search(page, "返金");

        await expect(page.locator("ol li")).toHaveCount(4);

        // Each result must mark its own occurrence and only that one.
        for (let index = 0; index < 4; index += 1) {
            await page.locator("ol li button").nth(index).click();
            await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();
            expect(await highlighted(page)).toBe("返金");
        }
    });

    test("keeps the right characters highlighted at 100%, 125% and 150% zoom", async ({ page }) => {
        await open(page);
        await search(page, "保管");
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        for (const level of ["100%", "125%", "150%"]) {
            for (let attempt = 0; attempt < 12; attempt += 1) {
                const current = (await page.getByLabel("Zoom level").textContent()) ?? "";
                if (current === level) break;
                await page.getByRole("button", { name: Number(current.replace("%", "")) > Number(level.replace("%", "")) ? "Zoom out" : "Zoom in" }).click();
            }

            await expect(page.getByLabel("Zoom level")).toHaveText(level);
            await page.waitForTimeout(400);
            expect(await highlighted(page)).toBe("保管");
        }
    });
});
