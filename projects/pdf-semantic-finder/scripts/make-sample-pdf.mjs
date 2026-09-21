/**
 * Generates the development sample PDFs used for local verification.
 *
 * These are NOT the acceptance fixtures that `docs/spec.md` §11.1 calls for — those are three
 * separate documents with an authored 20-query evaluation set, described in
 * `tests/fixtures/README.md`. These exist so the viewer, highlighting, zoom, concurrency, and
 * limit behaviour can be checked locally before those arrive.
 *
 * Usage: npm run fixtures:sample
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../tests/fixtures");
const scratch = resolve(here, "../node_modules/.tmp/fixture-html");

const STYLE = (fontSize, lineHeight, margin) =>
    `@page{size:A4;margin:${margin}}body{font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif;font-size:${fontSize};line-height:${lineHeight}}p{margin:0 0 .3em;text-align:justify}.pb{page-break-before:always}`;

const html = (style, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`;

/**
 * The declared character limit, read from the source of truth rather than copied.
 *
 * `src/lib/types.ts` is TypeScript and this script is plain Node, so the value is matched out of
 * it. That is uglier than an import and it is worth it: the over-limit fixture below silently
 * stopped being over the limit **twice** as the limit was raised, and both times the failure
 * looked like a product defect rather than a stale fixture.
 */
const maxExtractedCharacters = Number(
    /maxExtractedCharacters: ([\d_]+)/u.exec(await readFile(resolve(here, "../src/lib/types.ts"), "utf8"))[1].replaceAll("_", ""),
);

/** The declared page limit, read from the same source as the character limit. */
const LIMITS_PAGE_COUNT = Number(/maxPageCount: ([\d_]+)/u.exec(await readFile(resolve(here, "../src/lib/types.ts"), "utf8"))[1].replaceAll("_", ""));

/** Characters one `densePage` produces, measured: 45 paragraphs of about 137 characters. */
const DENSE_PAGE_CHARACTERS = 6_200;

/** Pages needed to clear the character limit by a quarter, so a modest rise cannot swallow it. */
const overLimitPageCount = Math.ceil((maxExtractedCharacters * 1.25) / DENSE_PAGE_CHARACTERS);

/** A page whose text is dense enough to push the document past the character cap. */
const densePage = (index) => {
    const clause = "本条に定める事項について、甲および乙は誠実に協議のうえこれを決定するものとし、協議が調わない場合には別途定める手続によるものとする。";
    const paragraphs = Array.from({ length: 45 }, (_, n) => `<p>第${index * 45 + n + 1}項 ${clause}${clause}</p>`).join("");
    return `<div class="${index === 0 ? "" : "pb"}">${paragraphs}</div>`;
};

/**
 * A page of a document that lands just inside the character cap rather than past it.
 *
 * `densePage` deliberately overshoots so search is blocked; this one aims for roughly 4,700
 * characters a page over ten pages — about 47,000 against the 50,000 limit — so the search is
 * actually attempted. Numbered clauses keep the segmentation realistic rather than producing one
 * enormous paragraph.
 */
const nearLimitPage = (index) => {
    const sentence = "本条に定める事項について、甲および乙は誠実に協議のうえこれを決定するものとし、協議が調わない場合には別途定める手続によるものとする。";
    const paragraphs = Array.from({ length: 39 }, (_, n) => `<p>第${index * 39 + n + 1}条　${sentence}</p>`).join("");
    return `<div class="${index === 0 ? "" : "pb"}">${paragraphs}</div>`;
};

/**
 * A minimal PDF that declares the standard security handler.
 *
 * The `/O` and `/U` strings are arbitrary, so the empty user password never validates and PDF.js
 * raises `PasswordException` with `NEED_PASSWORD`. Built by hand because encrypting a PDF needs a
 * tool this repository does not depend on.
 */
const buildEncryptedPdf = () => {
    const objects = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>",
        `<</Filter/Standard/V 1/R 2/O <${"A1".repeat(32)}>/U <${"B2".repeat(32)}>/P -1>>`,
    ];

    let pdf = "%PDF-1.4\n";
    const offsets = [];

    objects.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xref = pdf.length;
    const id = "0123456789ABCDEF".repeat(2);

    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R/Encrypt 4 0 R/ID[<${id}><${id}>]>>\n`;
    pdf += `startxref\n${xref}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
};

const DOCUMENTS = [
    {
        name: "sample-contract-ja.pdf",
        source: async () => readFile(resolve(here, "sample-contract.html"), "utf8"),
    },
    {
        // Spec §10: a page with no extractable text is named, and the rest stays searchable.
        name: "sample-blank-page-ja.pdf",
        source: async () =>
            html(
                STYLE("10.5pt", "1.9", "20mm"),
                "<div><p>第1条（目的）これは1ページ目です。本契約の目的を定めます。</p></div>" +
                    '<div class="pb"><div style="height:250mm"></div></div>' +
                    '<div class="pb"><p>第3条（中途解約）これは3ページ目です。既に支払われた料金の返還は行わないものとする。</p></div>',
            ),
    },
    {
        // Spec §10: over a declared limit, the document still renders but search is blocked.
        name: "sample-over-limit-ja.pdf",
        source: async () => html(STYLE("5pt", "1.15", "8mm"), Array.from({ length: overLimitPageCount }, (_, i) => densePage(i)).join("")),
    },
    {
        /*
         * The subject of the §11.1 evaluation set, deliberately not a document any heuristic was
         * tuned on. Segmentation, thresholds and batching were all settled against
         * `sample-contract.html` and `assets/bitcoin.pdf`; measuring quality on those reports the
         * fit rather than the quality.
         */
        name: "eval-terms-ja.pdf",
        source: async () => readFile(resolve(here, "eval-terms.html"), "utf8"),
    },
    {
        /*
         * A document just inside every declared limit, for timing a near-capacity search. The
         * §6.4 deadline arithmetic has only ever been checked against documents a fraction of the
         * size, so it is the one number the limits rest on that nothing measures.
         *
         * 48 pages of 39 short 条 each approaches both limits at once, which is the point: the page
         * limit and the character limit are derived from one another, so a fixture near one and
         * far from the other tests neither. Short provisions rather than long ones, because what
         * drives the request count is the number of units, not the number of characters.
         */
        name: "sample-near-limit-ja.pdf",
        source: async () => html(STYLE("7pt", "1.4", "12mm"), Array.from({ length: 48 }, (_, index) => nearLimitPage(index)).join("")),
    },
    {
        /*
         * Spec §2 does not claim to handle side-by-side text. Extraction splits at the gutter so
         * the columns do not fuse into one sentence, but the reading order between them is still
         * row by row — so the page has to be reported rather than silently trusted.
         *
         * Built as two floated blocks rather than with CSS columns: `column-count` lays text out
         * in a single flow, and the extracted item positions come out the same as a real
         * two-column page either way.
         */
        name: "sample-two-column-ja.pdf",
        source: async () => {
            const column = (prefix) =>
                Array.from(
                    { length: 22 },
                    (_, n) => `<p>${prefix}第${n + 1}項 本項に定める事項については、甲および乙が別途協議のうえ決定するものとする。</p>`,
                ).join("");
            return html(
                `${STYLE("9pt", "1.7", "15mm")}.col{width:45%;float:left}.col+.col{margin-left:10%}`,
                `<div class="col">${column("左")}</div><div class="col">${column("右")}</div>`,
            );
        },
    },
    {
        /*
         * One page past the page cap, and dense, so rejecting it costs almost nothing while
         * extracting it would cost plenty.
         *
         * The page count is now checked the moment the document opens, before any page's text is
         * read. Before that it was checked after every page had been extracted, so a compact file
         * claiming thousands of pages was fully parsed and then discarded. This fixture is what
         * makes the difference observable: the same pages the over-limit fixture uses, one past
         * the limit.
         */
        name: "sample-too-many-pages-ja.pdf",
        source: async () =>
            html(
                STYLE("9pt", "1.4", "12mm"),
                // Sparse pages, so the file stays small, and a great many of them, so the cost of
                // extracting them is dominated by the per-page round trip to the PDF.js worker.
                // That is what makes the ordering observable: rejecting on the page count is
                // constant work, extracting first is a thousand round trips.
                Array.from(
                    { length: 1_000 },
                    (_, index) => `<p class="${index === 0 ? "" : "pb"}">第${index + 1}項 本条に定める事項について協議する。</p>`,
                ).join(""),
            ),
    },
    {
        /*
         * A document that stays inside the page cap and still carries more text than extraction
         * will read.
         *
         * The page cap says nothing about how much text one page may hold. This is 48 pages at
         * about 25,000 characters each — over a million in total, against a 200,000 limit — and
         * extraction gives up around page 38. That is what the ceiling exists for: a page limit
         * alone does not bound the work, and a public release cannot assume documents are
         * reasonable. Measured, not assumed; `limits.spec.ts` pins the behaviour rather than the
         * exact page it stops on, which depends on how the text happens to flow.
         */
        name: "sample-dense-ja.pdf",
        source: async () =>
            html(
                '@page{size:A4;margin:4mm}body{font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif;font-size:2pt;line-height:1.02}p{margin:0;text-align:justify}.pb{page-break-before:always}',
                Array.from(
                    { length: 24 },
                    (_, index) =>
                        `<div class="${index === 0 ? "" : "pb"}">` +
                        Array.from(
                            { length: 600 },
                            (_, n) =>
                                `<p>第${index * 600 + n + 1}項 本条に定める事項について、甲および乙は誠実に協議のうえこれを決定するものとし、協議が調わない場合には別途定める手続によるものとする。</p>`,
                        ).join("") +
                        `</div>`,
                ).join(""),
            ),
    },
    {
        /*
         * Supplementary-plane characters, for the offset arithmetic exact search depends on.
         *
         * `𠮟` is one code point and two UTF-16 units. `indexOf` and `.length` deal in units while
         * every offset in the extraction is a code point, so one of these characters used to shift
         * every match after it — the highlight landed on the wrong characters, or the hit came back
         * with no range at all for text the document plainly contained.
         *
         * The phrase is repeated so the viewer also has to pick the right occurrence, and the
         * document is fictional.
         */
        name: "sample-supplementary-ja.pdf",
        source: async () =>
            html(
                STYLE("11pt", "1.9", "20mm"),
                [
                    "<p>第1条（懲戒）会社は、𠮟責のうえ返金を行うことがある。</p>",
                    "<p>第2条（返金）前条の返金は、𠮟責の記録とともに保管する。</p>",
                    "<p>第3条（適用）𠮟責を伴わない返金についても本規程を適用する。</p>",
                    "<p>この文書は架空のものであり、実在する企業、製品、規程とは一切関係がありません。</p>",
                ].join(""),
            ),
    },
    {
        // Spec §10: a document PDF.js can open but that yields no text at all.
        name: "sample-no-text.pdf",
        source: async () =>
            html(
                STYLE("10pt", "1.5", "20mm"),
                '<svg width="400" height="300"><rect x="10" y="10" width="380" height="280" fill="#ddd"/>' +
                    '<circle cx="200" cy="150" r="90" fill="#888"/></svg>',
            ),
    },
];

await mkdir(fixtures, { recursive: true });

// Spec §10: password-protected documents stop loading with the reason. Written directly; it needs
// no rendering.
await writeFile(resolve(fixtures, "sample-encrypted.pdf"), buildEncryptedPdf());
console.log(`Wrote ${resolve(fixtures, "sample-encrypted.pdf")}`);
await mkdir(scratch, { recursive: true });

const browser = await chromium.launch();

try {
    const page = await browser.newPage();

    for (const document of DOCUMENTS) {
        const htmlPath = resolve(scratch, `${document.name}.html`);
        await writeFile(htmlPath, await document.source());
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
        // Chromium embeds a subset of the system Japanese font with a ToUnicode map, so the result
        // is an ordinary text-based PDF that PDF.js can extract.
        await page.pdf({ path: resolve(fixtures, document.name), format: "A4", printBackground: true });
        console.log(`Wrote ${resolve(fixtures, document.name)}`);
    }
} finally {
    await browser.close();
}
