/**
 * The layout on a screen too narrow for two panes (spec §3).
 *
 * At 390×844 the results pane kept its 336 pixels and its 280-pixel floor, the divider took six
 * more, and the PDF was left with about eighteen. Dragging a divider is not an answer on a phone,
 * so below the breakpoint the two panes are shown one at a time.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sample-contract-ja.pdf");

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe("on a phone-sized screen", () => {
    test.skip(() => !existsSync(FIXTURE), "run `npm run fixtures:sample` first");
    test.use({ viewport: { width: 390, height: 844 } });

    const open = async (page: Page) => {
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);
    };

    const pane = (page: Page, name: "results" | "document") => page.getByRole("radio", { name, exact: true });

    test("gives the document the whole width, and never scrolls the page sideways", async ({ page }) => {
        await open(page);

        // The reproduced defect: the PDF had 18 pixels and the controls were cut off.
        const viewer = await page.locator("section").first().boundingBox();
        const rendered = await page.locator(".pdf-finder-page").first().boundingBox();
        expect(viewer!.width).toBeGreaterThan(300);
        expect(rendered!.width).toBeGreaterThan(250);

        expect(await overflows(page)).toBe(false);
        await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
        await expect(page.getByLabel("Zoom level")).toBeVisible();
    });

    test("shows one pane at a time, with no divider to drag", async ({ page }) => {
        await open(page);

        await expect(pane(page, "document")).toHaveAttribute("aria-checked", "true");
        await expect(page.locator("aside")).toBeHidden();
        await expect(page.getByRole("separator", { name: "Resize results panel" })).toBeHidden();

        await pane(page, "results").click();
        await expect(page.locator("aside")).toBeVisible();
        await expect(page.locator("section").first()).toBeHidden();
        expect(await overflows(page)).toBe(false);
    });

    test("takes the reader to the passage they select, and lets them come back", async ({ page }) => {
        await open(page);

        // Exact search needs no credential and no interception.
        await pane(page, "results").click();
        await page.getByRole("radio", { name: "Exact text", exact: true }).click();
        await page.getByLabel("Search query").fill("解約");
        await page.getByRole("button", { name: "Search", exact: true }).click();

        // Searching turns to the answers, since that is what was asked for.
        await expect(pane(page, "results")).toHaveAttribute("aria-checked", "true");
        await expect(page.locator("ol li")).not.toHaveCount(0);
        const chosen = (await page.locator("ol li span.line-clamp-4").nth(1).innerText()).slice(0, 12);

        // Choosing a passage means "take me to it".
        await page.locator("ol li > button").nth(1).click();
        await expect(pane(page, "document")).toHaveAttribute("aria-checked", "true");
        await expect(page.locator(".pdf-finder-highlight").first()).toBeVisible();

        // And back, with the search and the selection intact.
        await pane(page, "results").click();
        await expect(page.getByLabel("Search query")).toHaveValue("解約");
        await expect(page.locator("ol li > button[aria-current='true']")).toContainText(chosen);
    });

    test("keeps the reader's place in the document across a pane switch", async ({ page }) => {
        // Both panes stay mounted: unmounting the viewer would tear down every canvas and text
        // layer, and the reader would come back to page one.
        await open(page);

        await page.locator(".pdf-finder-page").nth(1).scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        const before = await page.getByText(/^\d+ \/ \d+$/u).innerText();

        await pane(page, "results").click();
        await pane(page, "document").click();
        await page.waitForTimeout(400);

        expect(await page.getByText(/^\d+ \/ \d+$/u).innerText()).toBe(before);
    });
});

test.describe("at the breakpoint itself", () => {
    test.skip(() => !existsSync(FIXTURE), "run `npm run fixtures:sample` first");
    test.use({ viewport: { width: 768, height: 900 } });

    test("shows both panes, and still does not scroll sideways", async ({ page }) => {
        await page.goto("/");
        await page.setInputFiles('input[type="file"]', FIXTURE);
        await page.waitForSelector(".pdf-finder-page");

        await expect(page.locator("aside")).toBeVisible();
        await expect(page.locator("section").first()).toBeVisible();
        await expect(page.getByRole("radio", { name: "document", exact: true })).toHaveCount(0);
        expect(await overflows(page)).toBe(false);
    });
});
