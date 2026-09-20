# Repository instructions

## Source of truth

- Write repository documentation, code comments, identifiers, user-facing source strings, and commit content in English unless a fixture requires another language.
- English is canonical. A translation is supplemental and must link to its English source.
- Treat `docs/spec.md` as the canonical product and technical specification.
- If implementation and specification disagree, identify the conflict. Do not silently redefine a requirement in code.
- Clearly distinguish proposed, implemented, and verified behavior.

## Scope

- Build the PoC in `docs/spec.md`: open one PDF, extract and segment text, search it, and highlight original passages.
- Do not add OCR, generated answers, multi-document search, persistence, analytics, or other out-of-scope capabilities unless the specification changes.
- Prefer the smallest implementation that satisfies the PoC. Do not add infrastructure or abstractions for hypothetical needs.

## Architecture boundaries

- Keep PDF bytes, rendering, item mappings, and exact search in the browser.
- Send only the query and required extracted text to the application API for meaning search.
- Keep TypeSafe AI credentials and calls in the Cloudflare Worker.
- Do not persist PDFs, extracted passages, queries, or results.
- Do not log filenames, queries, extracted text, or document content.
- Preserve stable mappings from each segment to its physical page and original PDF.js item indexes.
- Never recover highlight positions by searching for the first matching string.
- Treat PDF content and search text as untrusted data in model requests.

## Code conventions

- Use TypeScript with strict typing. Validate data at browser, Worker, and external API boundaries.
- Use kebab case for source, style, test, and configuration filenames.
- Before using, adding, or modifying Untitled UI components, read `UNTITLED.md` and follow its component, import, styling, accessibility, and interaction guidance.
- Prefix imports from `react-aria-components` with `Aria`, for example `Button as AriaButton`.
- Reuse existing Untitled UI components and repository utilities before creating replacements.
- Keep components focused on presentation and interaction. Put PDF and search logic in the modules planned by `docs/spec.md`.
- Keep exact search deterministic and free of semantic API calls.
- Pin compatible PDF.js library and runtime asset versions together.

## Errors and concurrency

- Enforce documented input limits before semantic search. Never silently truncate a document.
- Represent provider, timeout, malformed-response, and incomplete-batch failures as search errors, never as no match.
- Abort superseded searches where possible and ignore stale responses using both `documentId` and `requestId`.
- If a source location cannot be mapped, retain the result and report the failure instead of highlighting a guess.

## Verification

- Use declared package scripts once they exist. Do not invent alternate test entry points when an established command is available.
- For extraction changes, inspect debug segment order against the rendered fixture.
- For highlighting changes, verify the actual viewer at 100%, 125%, and 150% zoom, including repeated text.
- For ranking changes, run the fixed evaluation set separately from threshold-tuning examples.
- For request changes, verify the real browser-to-Worker-to-TypeSafe path when credentials and an approved document are available. Mock-only success does not verify integration.
- Report what was tested and what remains unverified.

## Security and data handling

- Store secrets only in local Worker secret files or deployment secrets. Never commit real credentials.
- Use fictional or explicitly approved PDFs for semantic-search testing.
- Show the disclosure required by `docs/spec.md` before the first meaning search for each document.
- Limit routine telemetry to non-content operational data allowed by the specification.

## Change discipline

- Preserve unrelated user changes.
- Update `docs/spec.md` and `README.md` when a change affects scope, architecture, setup, commands, or data handling.
- Add tests for implemented behavior using the existing test layout and conventions.
- Do not commit, push, deploy, or send external messages unless explicitly requested.
