# PDF Semantic Finder

A proof of concept for finding and highlighting relevant passages in a PDF with natural-language queries.

The app will let a reader open one text-based PDF, search in their own words, review the most relevant original passages, and jump to highlighted source text. It retrieves passages rather than generating answers.

## Project status

The proof of concept is implemented. Opening a PDF, extraction, segmentation, exact search,
highlighting, and the application API are working and verified in a real browser.

**Verified against the live provider.** A real browser-to-Worker-to-TypeSafe search returns the
intended passage on both sample documents: 86 units and 22 requests in 1,055 ms on
`assets/bitcoin.pdf`, and 13 units in 269 ms on the generated Japanese contract, where the top
result is the single 中途解約 clause that answers the §13 demonstration query.

**Measured, and acted on.** What moves an uncertain passage's score is what sits in one request's
`state`, not the number of questions asked over it. Every request in a search now carries the same
number of passages, and that number is four. That is a mitigation of one variable, not a cure:
holding the count at four and changing only the neighbours' length, their distance, or the target's
position still moved the verdict in 10 of 30 conditions. See `docs/spec.md` §14.19 for every
condition and number.

**Search quality, measured.** `npm run eval`, 32 queries over two documents, one run: 0 misses out
of 26 answerable queries, 26 of 26 with the intended passage in the top three, 0 false positives
out of 6. One document is a fictional Japanese fixture written so that nothing was tuned against
it; the other is the Bitcoin whitepaper with eighteen queries written by an outside reviewer. Those
outside queries found a segmentation defect on their first run — two pages whose figures outnumber
their prose were split line by line, so every answer arrived cut mid-sentence. Enough to say the
mechanism reaches the intended passage; not enough to calibrate the thresholds in `docs/spec.md`
§7, which remain hypotheses.

**Timing near the limits.** A 48-page document of 1,872 segments — 94% of the cap — and 468
requests completed in 5.2–5.5 s against a 15-second deadline, with the first passages on screen in
338–664 ms because the response is streamed. At the 300% zoom maximum it holds 827 MB of canvas —
measured, still usable, and the number that would decide any further page increase.

**Shown, not hidden.** Each meaning result now carries the model's own judgement of the passage —
the probability it assigned to the highest relevance level and its certainty in that — under a
persistent **Model judgment** line explaining what the numbers are. Hiding them was worse than
showing them: §14.19 found the same passage crossing all three of §7's bands depending on which
other passages shared its request, so a reader who cannot see the number cannot tell a passage the
model was sure of from one that scraped in at 0.36. It is never presented as a match percentage.

**Not yet verified:** whether §7's thresholds sit in the right place, behaviour at the 2,000-segment
cap itself, what a rate-limited retry costs inside the deadline, and whether a PDF's own text can
steer a judgement.

Places where the implementation had to settle a question the specification left open or
self-inconsistent are recorded in [docs/spec.md §14](docs/spec.md). The canonical requirements
remain in `docs/spec.md`; English is the canonical language.

## Scope

- React, Vite, and TypeScript web client
- Untitled UI React components
- PDF.js rendering, extraction, and source-position mapping
- Local exact-text search
- Meaning search through a Cloudflare Worker and TypeSafe AI Jev
- One text-based PDF of up to 10 MB, 50 pages and 200,000 extracted characters
- Up to three original-passage results with page navigation and highlighting
- No OCR, generated answers, database, or persistent document storage

The PDF file remains in the browser. Meaning search sends the query and extracted passages to the application API and TypeSafe AI.

## Intended architecture

```text
PDF in browser
  → PDF.js rendering and text extraction
  → stable segments linked to PDF text items
  → exact search in browser, or semantic scoring through the Worker
  → ranked original passages
  → page navigation and text-layer highlighting
```

## Development

```bash
npm install          # also copies the PDF.js runtime assets into public/pdfjs/
npm run dev          # Vite and the Worker on http://localhost:5173, one origin
npm run build        # type-check every project and build the client and the Worker
npm run typecheck    # tsc -b across app, worker, node, and test projects
npm test             # vitest: segmentation, highlighting, search client, validation, ranking
npm run test:e2e     # Playwright: viewer, highlighting, zoom, concurrency
npx prettier --write .   # the repo's formatting config is authoritative
npm run fixtures:sample  # generate the Japanese and limit-case sample PDFs
npm run verify       # assets + typecheck + unit tests + E2E, in one go
npm run eval         # the fixed evaluation set; needs fixture PDFs and a credential
npm run deploy       # build, then wrangler deploy
```

### Credentials

Credentials stay server side. Copy `.dev.vars.example` to `.dev.vars` for local development and
use `wrangler secret put` for a deployment. `.dev.vars` is gitignored; never commit real values.

```env
TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0
```

The model is pinned so evaluation runs are reproducible. Do not point it at a moving `latest` alias.

### PDF.js runtime assets

`scripts/copy-pdfjs-assets.mjs` copies `cmaps/`, `standard_fonts/`, `wasm/`, and `iccs/` out of the
installed `pdfjs-dist` into `public/pdfjs/`, which is gitignored and regenerated on install and
before every build. This is how the library and its runtime assets stay pinned to one version. The
CMaps are not optional: a Japanese PDF using a predefined CID encoding yields no usable text
without them.

### Verifying it works

[docs/local-verification.md](docs/local-verification.md) is the step-by-step runbook: install,
generate a sample PDF, run every automated check, and walk the acceptance criteria by hand in the
browser. `npm run verify` runs the automated part. A Japanese translation is at
[docs/local-verification.ja.md](docs/local-verification.ja.md).

### Fixture PDFs

`npm run fixtures:sample` generates a development sample so the viewer can be exercised
immediately. It is **not** an acceptance fixture: the three fictional Japanese PDFs that
`docs/spec.md` §11.1 requires, and the 20-query evaluation set authored against them, are still
outstanding. See `tests/fixtures/README.md`. `npm run eval` refuses to run until they exist.

## How it works

[docs/how-search-works.md](docs/how-search-works.md) walks through the implemented mechanism with
real captured data: how text items become segments, what the Jev request and response actually look
like, how relevance is decided, and how a result is mapped back to a position on the page. A
Japanese translation is at [docs/how-search-works.ja.md](docs/how-search-works.ja.md), and
[docs/how-search-works-eli5.ja.html](docs/how-search-works-eli5.ja.html) is a picture-led Japanese
walkthrough of segmentation and the Jev request for readers new to the project.

## Architecture

| Area                                              | Where                                 |
| ------------------------------------------------- | ------------------------------------- |
| PDF bytes, rendering, item mappings, exact search | Browser only                          |
| Query and extracted passage text                  | Sent to the Worker for meaning search |
| TypeSafe credentials and calls                    | Cloudflare Worker only                |
| Persistence                                       | None; nothing is stored               |

Highlighting resolves a result to its physical page and original PDF.js text-item indexes, then to
the elements PDF.js created from the same `TextContent`. Both kinds of result carry character
offsets within those items: two exact matches inside one text item highlight different words, and a
meaning result covers its own passage even when one oversized item spans several segments. A
passage is never located by searching the rendered text for a matching string, which would resolve
repeated text to the wrong occurrence.

Exact search does not use segments: each page is indexed as one continuous string so a phrase
straddling two segments is still found. Segments are the unit meaning search evaluates.

Logs carry elapsed time, segment count, model ID, provider token totals, and error codes. They never
carry a filename, a query, or document content.

## Documentation policy

- English documents are authoritative.
- Translations may be added for convenience and must link to their English source.
- If a translation conflicts with English, follow the English source and update the translation.
- Product-scope changes belong in `docs/spec.md` before or with the implementation.

## Contributing

Follow [AGENTS.md](AGENTS.md). Keep changes within the PoC scope and distinguish proposed behavior from implemented and verified behavior.

## References

- [Product specification](docs/spec.md)
- [TypeSafe AI documentation](https://docs.typesafe.ai/)
- [PDF.js documentation](https://mozilla.github.io/pdf.js/)
- [Untitled UI React](https://www.untitledui.com/react)
