# Jev Playground

Experiments and sample projects built with Jev (TypeSafe AI).

## Projects

- [PDF Semantic Finder](projects/pdf-semantic-finder/README.md) — a web application that searches
  the text inside a PDF by meaning rather than by string, and highlights the passage it found in the
  original document. React, TypeScript, PDF.js and Cloudflare Workers.

## Running one locally

```bash
cd projects/pdf-semantic-finder
npm install
cp .dev.vars.example .dev.vars
```

Meaning search needs a credential: set `TYPESAFE_API_KEY` in `.dev.vars`. Exact text search works
without one, because it never leaves the browser.

```bash
npm run dev
```

Then open http://localhost:5173.

See the [project's README](projects/pdf-semantic-finder/README.md) for building, testing and
deploying.
