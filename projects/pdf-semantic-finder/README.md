# PDF Semantic Finder

A proof of concept for finding and highlighting relevant passages in a PDF with natural-language queries.

The app will let a reader open one text-based PDF, search in their own words, review the most relevant original passages, and jump to highlighted source text. It retrieves passages rather than generating answers.

## Project status

The proof of concept is implemented. Opening a PDF, extraction, segmentation, exact search,
highlighting, and the application API are working and verified in a real browser.

**Not yet verified:** the browser to Worker to TypeSafe AI path has never been exercised against
the live provider, because no `TYPESAFE_API_KEY` has been available. The Worker is covered by unit
tests and the client by end-to-end tests against an intercepted endpoint. The search-quality target
in `docs/spec.md` §11.1 and the latency target in §11.3 are **unmeasured**, and the fixture PDFs
they need are not in the repository (see `tests/fixtures/README.md`).

Places where the implementation had to settle a question the specification left open or
self-inconsistent are recorded in [docs/spec.md §14](docs/spec.md). The canonical requirements
remain in `docs/spec.md`; English is the canonical language.

## Scope

- React, Vite, and TypeScript web client
- Untitled UI React components
- PDF.js rendering, extraction, and source-position mapping
- Local exact-text search
- Meaning search through a Cloudflare Worker and TypeSafe AI Jev
- One text-based PDF of up to 10 MB and 10 pages
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
npm run fixtures:sample  # generate a Japanese sample PDF for local verification
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
the elements PDF.js created from the same `TextContent`. A passage is never located by searching the
rendered text for a matching string, which would resolve repeated text to the wrong occurrence.

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
