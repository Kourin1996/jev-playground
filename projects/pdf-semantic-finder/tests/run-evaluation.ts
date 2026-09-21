/**
 * Fixed evaluation harness (spec §11.1).
 *
 * Run with `npm run eval`. Deliberately not part of `npm test`: it needs the fixture PDFs, a
 * running application, and a real TypeSafe credential, so it measures quality rather than
 * checking behaviour.
 *
 * Results are a measurement of this run against these fixtures. They are not a guarantee for
 * unseen PDFs.
 *
 * **What it waits for matters as much as what it measures.** It used to resolve as soon as any
 * result appeared. Under streaming that list is provisional — the panel says so on screen — so a
 * score taken then could be of a ranking that was still changing, and the next query could start
 * while the previous search was still running. It now waits for the interface to commit a verdict
 * before reading anything from it.
 */
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Explicit extension: `npm run eval` runs under Node's type stripping, which does not resolve
// extensionless TypeScript the way the bundler does.
import { hasSettled, outcomeOfSettledPanel } from "./evaluation-state.ts";
import type { SearchOutcome } from "./evaluation-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDF_FINDER_URL ?? "http://localhost:5173";

/**
 * How long to wait out the endpoint's per-client limit.
 *
 * `wrangler.jsonc` declares six searches a minute, so a full run of this set is paced by admission
 * rather than by the provider. Matched to that window rather than guessed.
 */
const RETRY_AFTER_SECONDS = Number(process.env.PDF_FINDER_RETRY_AFTER ?? 60);

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

/**
 * Runs one query and waits for the interface to commit a verdict.
 *
 * The response is watched for its status only. Its **body** cannot be read here: the application
 * consumes the stream and cancels the reader when it has its answer, so a second consumer gets an
 * error rather than the text — which is how the first attempt at this reported every search as
 * unreadable.
 */
const runQuery = async (page: Page, query: string): Promise<SearchOutcome> => {
    const responded = page.waitForResponse((response) => response.url().includes("/api/search"), { timeout: 60_000 });

    await page.getByRole("radio", { name: "Meaning", exact: true }).click();
    await page.getByLabel("Search query").fill(query);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    const response = await responded;

    // Polled from here rather than inside the page, so the rule lives in one testable function
    // instead of being restated as a serialised predicate.
    for (let attempt = 0; attempt < 600; attempt += 1) {
        const text = await page.evaluate(() => document.body.innerText);
        if (hasSettled(text)) return outcomeOfSettledPanel(text, response.status());
        await page.waitForTimeout(100);
    }

    throw new Error("the interface never committed a terminal state");
};

/**
 * Runs one query, waiting out the admission limit rather than recording it as a failure.
 *
 * The **application** must never retry a 429 by itself — that is the amplification the limiter
 * exists to prevent, and spec §9.1 says so. A measurement harness is a different thing: it is one
 * operator asking for a complete run, and waiting the stated interval is exactly what a
 * well-behaved client does. It waits for what `Retry-After` asked for, never a blind loop.
 */
const runQueryPatiently = async (page: Page, query: string): Promise<SearchOutcome> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const outcome = await runQuery(page, query);
        if (outcome.kind !== "error" || outcome.code !== "rate_limited") return outcome;

        const wait = RETRY_AFTER_SECONDS * 1_000;
        console.log(`      rate limited; waiting ${RETRY_AFTER_SECONDS}s before retrying`);
        await page.waitForTimeout(wait);
    }

    return { kind: "error", code: "rate_limited" };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const tally = new Map<string, { passed: number; total: number }>();

/**
 * The three rates spec §11.1 asks for, counted separately, plus the searches that never produced a
 * relevance outcome at all.
 *
 * A single pass count hides which way the search is wrong, and the two directions cost different
 * things: a miss sends the reader away believing the document does not say, while a false positive
 * costs them the time to read a passage and reject it. A provider failure is neither, and counting
 * it as a miss would blame the ranking for an outage.
 */
const rates = {
    answerable: 0,
    missed: 0,
    topThree: 0,
    unanswerable: 0,
    falsePositives: 0,
    providerErrors: 0,
};
const errorCodes = new Map<string, number>();
let loadedDocument = "";

for (const entry of cases) {
    if (entry.document !== loadedDocument) {
        await page.goto(BASE_URL);
        await page.setInputFiles('input[type="file"]', resolve(here, "fixtures", entry.document));
        await page.waitForSelector(".pdf-finder-page");
        await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);
        loadedDocument = entry.document;
    }

    const outcome = await runQueryPatiently(page, entry.query);

    if (outcome.kind !== "final") {
        // Not a relevance result at all. Counted and named, never folded into a miss.
        rates.providerErrors += 1;
        const code = outcome.kind === "error" ? outcome.code : outcome.reason;
        errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);

        const bucket = tally.get(entry.category) ?? { passed: 0, total: 0 };
        bucket.total += 1;
        tally.set(entry.category, bucket);
        console.log(`ERROR ${entry.id.padEnd(16)} ${entry.category.padEnd(12)} ${code}`);
        continue;
    }

    const results = await page.locator("ol li span.line-clamp-4").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    let passed: boolean;

    if (entry.expect.kind === "top3_contains") {
        rates.answerable += 1;
        const snippet = normalize(entry.expect.snippet);
        const found = results.slice(0, 3).some((text) => normalize(text).includes(snippet));

        // A miss and a wrong top three are different failures. The answer is in the searchable
        // text either way, so returning nothing is the worse of the two.
        if (outcome.status === "no_match") rates.missed += 1;
        if (found) rates.topThree += 1;
        passed = found;
    } else if (entry.expect.status === "matched") {
        rates.unanswerable += 1;
        // A no-answer query must not produce a confident match; `uncertain` is an acceptable hedge.
        passed = outcome.status !== "matched";
        if (!passed) rates.falsePositives += 1;
    } else {
        passed = outcome.status !== entry.expect.status;
    }

    const bucket = tally.get(entry.category) ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (passed) bucket.passed += 1;
    tally.set(entry.category, bucket);

    console.log(`${passed ? "PASS" : "FAIL"}  ${entry.id.padEnd(16)} ${entry.category.padEnd(12)} ${outcome.status.padEnd(9)} ${entry.query}`);
}

console.log("\nBy category:");
for (const [category, bucket] of tally) console.log(`  ${category.padEnd(12)} ${bucket.passed}/${bucket.total}`);

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`);

console.log("\nRates (spec §11.1):");
console.log(
    `  miss            ${rates.missed}/${rates.answerable}  ${percent(rates.missed, rates.answerable)}   the answer is in the searchable text, the search returned nothing`,
);
console.log(
    `  top-3 hit       ${rates.topThree}/${rates.answerable}  ${percent(rates.topThree, rates.answerable)}   the intended passage is among the results shown`,
);
console.log(
    `  false positive  ${rates.falsePositives}/${rates.unanswerable}  ${percent(rates.falsePositives, rates.unanswerable)}   no answer exists, the search reported a match`,
);
console.log(`  provider error  ${rates.providerErrors}/${cases.length}  ${percent(rates.providerErrors, cases.length)}   no relevance outcome was produced`);
for (const [code, count] of errorCodes) console.log(`      ${code.padEnd(28)} ${count}`);

const totals = [...tally.values()].reduce((sum, bucket) => ({ passed: sum.passed + bucket.passed, total: sum.total + bucket.total }), { passed: 0, total: 0 });
console.log(`\nTotal ${totals.passed}/${totals.total}`);
console.log("Measured against this fixture on this run; not a guarantee for unseen PDFs.");
console.log("The thresholds in spec §7 are hypotheses. These rates are what they should be calibrated against.");

await browser.close();
process.exit(totals.passed === totals.total ? 0 : 1);
