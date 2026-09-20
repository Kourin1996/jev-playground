/**
 * Fixed evaluation harness (spec §11.1).
 *
 * Run with `npm run eval`. Deliberately not part of `npm test`: it needs the fixture PDFs, a
 * running application, and a real TypeSafe credential, so it measures quality rather than
 * checking behaviour.
 *
 * Results are a measurement of this run against these fixtures. They are not a guarantee for
 * unseen PDFs.
 */
import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDF_FINDER_URL ?? "http://localhost:5173";

type Case = {
    id: string;
    document: string;
    category: string;
    query: string;
    expect: { kind: "top3_contains"; snippet: string } | { kind: "status_not"; status: string };
};

/** The same normalization exact search uses, so a snippet matches however the PDF spaces it. */
const normalize = (text: string): string =>
    text
        .normalize("NFKC")
        .replace(/[​-‍⁠﻿]/gu, "")
        .toLowerCase()
        .replace(/\s+/gu, "");

const cases = (JSON.parse(readFileSync(resolve(here, "evaluation-cases.json"), "utf8")) as { cases: Case[] }).cases;

const missing = [...new Set(cases.map((entry) => entry.document))].filter((name) => !existsSync(resolve(here, "fixtures", name)));

if (missing.length > 0) {
    console.error(`Missing fixture PDFs: ${missing.join(", ")}`);
    console.error("See tests/fixtures/README.md. Nothing was evaluated.");
    process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const tally = new Map<string, { passed: number; total: number }>();
let loadedDocument = "";

for (const entry of cases) {
    if (entry.document !== loadedDocument) {
        await page.goto(BASE_URL);
        await page.setInputFiles('input[type="file"]', resolve(here, "fixtures", entry.document));
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);
        loadedDocument = entry.document;
    }

    await page.locator('label:has-text("Meaning")').click();
    await page.getByLabel("Search query").fill(entry.query);
    await page.getByRole("button", { name: "Search" }).click();

    const disclosure = page.getByRole("button", { name: "Continue" });
    if (await disclosure.isVisible().catch(() => false)) await disclosure.click();

    await page.waitForFunction(() => document.querySelectorAll("ol li").length > 0 || document.body.innerText.includes("No relevant passage"), null, {
        timeout: 30_000,
    });

    const results = await page.locator("ol li span.line-clamp-4").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    const isNoMatch = results.length === 0;

    let passed: boolean;

    if (entry.expect.kind === "top3_contains") {
        const snippet = normalize(entry.expect.snippet);
        passed = results.slice(0, 3).some((text) => normalize(text).includes(snippet));
    } else if (entry.expect.status === "matched") {
        // A no-answer query must not produce a normal match; uncertain is acceptable.
        passed = isNoMatch || (await page.getByText("may be related").count()) > 0;
    } else {
        passed = true;
    }

    const bucket = tally.get(entry.category) ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (passed) bucket.passed += 1;
    tally.set(entry.category, bucket);

    console.log(`${passed ? "PASS" : "FAIL"}  ${entry.id.padEnd(16)} ${entry.category.padEnd(12)} ${entry.query}`);
}

console.log("\nBy category:");
for (const [category, bucket] of tally) console.log(`  ${category.padEnd(12)} ${bucket.passed}/${bucket.total}`);

const totals = [...tally.values()].reduce((sum, bucket) => ({ passed: sum.passed + bucket.passed, total: sum.total + bucket.total }), { passed: 0, total: 0 });
console.log(`\nTotal ${totals.passed}/${totals.total}`);
console.log("Measured against these fixtures on this run; not a guarantee for unseen PDFs.");

await browser.close();
process.exit(totals.passed === totals.total ? 0 : 1);
