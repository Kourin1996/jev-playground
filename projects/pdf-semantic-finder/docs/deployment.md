# Deploying to pdf-finder.kourin.jp

_A Japanese translation is available: [deployment.ja.md](deployment.ja.md). This document is the
canonical one._

This is the runbook for putting the application on the public internet at
`pdf-finder.kourin.jp`, where anyone can reach it. It assumes the reader has the Cloudflare account
and a TypeSafe AI credential.

Read [§14.30 of the specification](spec.md) first if the question is what it will cost. The short
answer is the $5 Workers minimum plus about $0.004 a search.

## 1. What actually gets deployed

Worth being clear about, because most of the product is not on the server at all.

| Piece                                            | Where it runs        | Notes                                        |
| ------------------------------------------------ | -------------------- | -------------------------------------------- |
| Opening, rendering, extracting, segmenting a PDF | The reader's browser | The file never leaves it                     |
| Exact text search                                | The reader's browser | Makes no request at all                      |
| Meaning search                                   | Worker → TypeSafe AI | Only the query and the extracted text travel |
| The TypeSafe credential                          | Worker secret        | Never reaches the browser                    |

So a deployment is: a bundle of static files, one Worker of about 48 KiB, one Durable Object class,
and one rate-limit binding.

## 2. Prerequisites

**Workers Paid.** Not optional. A search at the 2,000-segment cap issues 500 provider calls in a
single invocation and up to 1,000 with retries; Workers Free allows 50 subrequests, which a
200-segment document already exceeds. `wrangler.jsonc` declares the allowance under `limits`, and
that key is honoured only on the standard usage model — so a Free-plan deploy fails at
`wrangler deploy` rather than at a reader's fiftieth subrequest, which is the point of declaring it.

**`kourin.jp` must already be a zone on the same Cloudflare account.** The route is configured as a
custom domain, so Cloudflare creates and manages the DNS record and the certificate for the
subdomain. It cannot do that for a zone it does not hold.

**A TypeSafe AI API key**, and the model pinned in `.dev.vars.example`.

**Authenticated wrangler**: `npx wrangler login`, then `npx wrangler whoami` to confirm the account.

## 3. Before the first deploy

### 3.1 Run the checks

```bash
npm ci
npm run fixtures:sample   # the suites skip loudly without these
npm run verify            # assets + typecheck + unit tests + end-to-end
```

`npm run verify` runs two servers: the Vite dev server and a `wrangler dev` preview built from
`dist/`. The preview is what the header tests run against, because the dev server models neither
Cloudflare's asset routing nor `public/_headers`.

On a cold start both come up at once while the build runs, and a browser test occasionally times out
waiting for a dev server that is still busy. Re-run it; if it passes with the servers warm, that was
the cause. A real failure repeats.

### 3.2 Set the secrets

```bash
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TYPESAFE_MODEL     # only if pinning something other than the default
```

`.dev.vars` is for local development and is gitignored. It is **not** uploaded: `wrangler deploy`
sends the Worker entry point and the contents of `dist/client`, and `.dev.vars` sits in
`dist/pdf_finder` beside the built Worker. Confirm with `npx wrangler deploy --dry-run` — the upload
should be the Worker and the asset count, nothing else.

### 3.3 Check the configuration is the one you mean

```bash
npm run build
npx wrangler deploy --dry-run
```

Expect exactly three bindings:

```
env.SEARCH_BUDGET (SearchBudget)             Durable Object
env.SEARCH_RATE_LIMIT (20 requests/60s)      Rate Limit
env.ASSETS                                   Assets
```

A missing binding does not fail the deploy. The Worker treats both admission bindings as optional so
that local development and the test suite work without them — it logs `admission_unavailable` and
continues. **That means a misconfigured deployment silently has no limiter**, which is why this
check is here and why §5.2 below exists.

Also confirm in `dist/pdf_finder/wrangler.json`:

- `"routes": [{"pattern": "pdf-finder.kourin.jp", "custom_domain": true}]`
- `"workers_dev": false` — otherwise the Worker is _also_ reachable at
  `pdf-finder.<account>.workers.dev`, which is a second public origin nobody announced, outside the
  zone's WAF and analytics.

## 4. Deploy

```bash
npm run deploy     # npm run build && wrangler deploy
```

The first deploy also creates the Durable Object class through the `v1` migration and asks
Cloudflare to provision the custom domain. DNS and the certificate can take a few minutes.

**Deploying over a Worker that was created in the dashboard.** The `pdf-finder` Worker on this
account was created there, from the "Hello world" template, and `pdf-finder.kourin.jp` was attached
to it — so the hostname, its DNS record and its certificate already exist and already answer 200.
`wrangler deploy` replaces that Worker's code rather than creating a second one, because
`wrangler.jsonc` declares the same `name`. Expect wrangler to ask for confirmation before
overwriting something last edited in the dashboard; a prompt is not answerable in a CI run, which is
one more reason the first deploy is manual. Once wrangler has deployed once, later deploys are not
overwriting dashboard edits and the question does not arise.

**Do the first one by hand, from a logged-in machine.** It provisions a hostname, runs a Durable
Object migration and needs the secrets to be in place already — none of which a CI token should be
doing the first time, when there is no known-good deployment to compare against. Once it has
succeeded and §5 passes, §12 hands the repeat deploys to GitHub Actions.

## 5. Verify the deployment

None of this can be checked locally. Do it every time, and record what you saw.

### 5.1 The app works at all

Open `https://pdf-finder.kourin.jp`, open a PDF, run an exact search, run a meaning search. Then
open the browser console and confirm it is **empty** — a Content-Security-Policy violation appears
there and nowhere else, and the local preview cannot prove the policy against the real asset paths.

Do this in Chrome, Firefox and Safari. The suite runs Chromium only.

### 5.2 The limits are real

**Per-client rate limit.** Run 21 searches inside a minute from one machine. The twenty-first should
answer `429` with a `Retry-After` header, and the interface should say so and _not_ retry by itself.

If it does not refuse, the binding is missing and the endpoint is unmetered. The Worker logs
`{"event":"admission_unavailable","gate":"rate_limit"}` in that case — check `npx wrangler tail`.

Note that the limit is evaluated per Cloudflare location, so it bounds one client rather than the
account, and testing it from one place is the only meaningful test of it.

**Provider budget.** The Durable Object refuses a search when the account-wide token budget is
committed. Confirm `{"event":"admission_unavailable","gate":"provider_budget"}` does **not** appear
in the logs; there is no easy way to provoke the refusal without a load test.

**Subrequest allowance.** Search a document near the 2,000-segment cap — `npm run fixtures:sample`
generates `sample-near-limit-ja.pdf` at 1,872 — and confirm it completes rather than failing partway.
Record the elapsed time. Locally it is 5.2–5.5 s; deployed throughput is not the same thing, because
Cloudflare also limits how many connections may be waiting on response headers.

**Read the real subrequest number** for the account's plan from Cloudflare's published limits. This
repository declares 1,100. Published figures for Paid have included both 1,000 and 10,000; at 1,000
a capped search with retries sits exactly on the boundary.

### 5.3 The headers arrived

```bash
curl -sD - -o /dev/null https://pdf-finder.kourin.jp/ | grep -i 'content-security-policy\|x-frame'
```

Check the same on a hashed asset under `/assets/`. Those are served by Cloudflare's asset router
**without invoking the Worker**, so they are covered by `public/_headers` rather than by code — a
separate mechanism, and the one more likely to be silently missing.

## 6. Rolling back

```bash
npx wrangler deployments list
npx wrangler rollback [version-id]
```

The Durable Object migration is not undone by a rollback. Nothing in this application depends on
that, because the object holds counters in memory and no stored data.

## 7. Operating it

**Logs** — `npx wrangler tail`. By §10 nothing logged carries a filename, a query, extracted text or
any document content. What is there: elapsed time, segment and batch counts, the model ID, provider
token usage, and error codes. Do not add more without re-reading §10.

**Cost** — TypeSafe is the variable half and it is roughly `segments × 600 × $42/10⁹`. Cloudflare is
the $5 minimum until about 300,000 searches a month. §14.30 has the workings.

**The thing to watch is not the money.** The provider budget lives in a single global Durable
Object, so every search in the world serialises through one instance. That is a latency bottleneck
and a single point of failure long before it is a cost, and it is the first thing to revisit if
traffic grows.

## 8. What is not covered, and should be said out loud

This is an honest list, not a disclaimer. Each of these is a real gap in a public deployment.

- **Keyboard and screen-reader access is incomplete.** The search-mode control is a hand-rolled
  radio group without arrow-key navigation or a roving tab stop, and there is no live region for
  search progress, completion, no-match or errors — so what a sighted reader sees change, a
  screen-reader user is not told. Recorded as R16 of the public-release review.
- **Streaming cancellation is partial.** A reader who navigates away closes the stream, but the
  in-flight provider calls are not aborted, and a batch that fails definitively still waits for its
  siblings.
- **CPU per search has never been measured.** The cost model assumes a generous 100 ms; even at that
  the included allowance covers 300,000 searches a month, so the conclusion is insensitive to it,
  but the number itself is an assumption.
- **`'wasm-unsafe-eval'` in the policy is precautionary.** No fixture in this repository exercises
  PDF.js's WebAssembly path, so removing the directive leaves the suite green. It stays because a
  reader's PDF may contain an image codec that needs it.
- **Only Chromium is tested.** Firefox and Safari are checked by hand at §5.1 and by nothing else.
- **The §7 relevance thresholds are hypotheses.** The held-out evaluation set says the mechanism
  reaches the intended passage — 26 of 26, 0 misses, 0 false positives — not that 0.65 and 0.35 are
  the right numbers.
- **No adversarial testing.** A PDF carrying instructions aimed at the model has not been tried
  against this deployment. The batch state is labelled untrusted in every question, which reduces
  the surface without establishing that ranking cannot be manipulated.

## 9. Deployability, checked

Run against the current tree on 2026-09-21. All of it is reproducible with `npx wrangler deploy --dry-run`.

| Check                                              | Result                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Worker bundle                                      | 47 KiB, 16 KiB gzipped — far inside the limit                             |
| Node built-ins in the bundle                       | none, so no `nodejs_compat` flag needed                                   |
| Static assets                                      | 208 files, largest 1.26 MB (the PDF.js worker)                            |
| `compatibility_date`                               | 2026-09-20, not in the future                                             |
| Bindings resolved                                  | `SEARCH_BUDGET`, `SEARCH_RATE_LIMIT`, `ASSETS`                            |
| Durable Object class exported from the entry point | yes                                                                       |
| Secrets in the upload                              | none; `.dev.vars` sits outside the asset root and outside the entry point |

Nothing here blocks a deploy. What remains is the account-side work in §2 and the verification in
§5, neither of which a dry run can do.

## 10. Before announcing it widely

The gates above are for a deployment that exists. Before pointing a large audience at it:

1. Close R16, or state plainly that the application is not yet keyboard-accessible.
2. Run the held-out evaluation set against the deployment rather than against localhost.
3. Watch the provider budget under real concurrency, with more than one person searching at once.
4. Decide what happens when the TypeSafe credential runs out of funds. Today that surfaces as a
   search error, which is correct but says nothing useful to the reader.

## 11. Publishing the repository

Separate from deploying, and the two are independent: the site can be public with the repository
private, or the reverse. This section is the repository half. `README.md` under
"Publishing this repository" records what was audited and what the conclusions were; this is the
procedure.

### 11.1 Re-run the checks rather than trusting the last ones

The audit is a statement about a tree that has since moved.

```bash
git ls-files | xargs grep -rlI -e 'sk-' -e 'BEGIN .*PRIVATE KEY' -e 'Bearer ' 2>/dev/null
git ls-files | grep -iE 'dev\.vars$|\.env$'          # expect nothing but .dev.vars.example
git log --all --oneline -S"$(sed -n 's/^TYPESAFE_API_KEY=//p' .dev.vars)" -- 2>/dev/null
git status --short --ignored | grep -E '^!!' | head   # confirm p/, docs/code-review-*, UNTITLED.md
```

The third command is the one that matters and the one most easily got wrong: it searches every
commit, not the working tree. An empty result is the answer you want, so confirm the search itself
works — run it once against a string you know is committed and see it match — before believing an
empty result. A scanner that silently matches nothing looks exactly like a clean repository.

`.dev.vars`, `p`, `docs/code-review-*.md` and `UNTITLED.md` are gitignored, not merely untracked.
That distinction is the point: untracked files are one `git add -A` away from being published, and
`docs/code-review-*.md` is a list of this deployment's open weaknesses.

### 11.2 It is already public

This project lives at `projects/pdf-semantic-finder` in
[Kourin1996/jev-playground](https://github.com/Kourin1996/jev-playground), which is a public
repository. The history was imported under that prefix with `git filter-repo`, so the commits are
the project's own and every path in them sits inside the prefix.

Publication is therefore a push, not a `gh repo create`, and §11.1 is the check to run **before**
each push rather than once. Anything not meant to be read has to go before the push, not after: a
force-push does not remove a commit somebody already fetched, and GitHub keeps unreachable objects
reachable by SHA for a while. Deleting the repository is the only reliable undo.

`package.json` carries `"private": true` and there is no `LICENSE`, so the repository is readable
without granting anyone rights. That is a coherent position and deliberate — publishing is not the
same as open-sourcing. Adding a licence later is a decision, not an oversight to correct in passing.

## 12. Deploying automatically from GitHub

`.github/workflows/deploy-pdf-semantic-finder.yml`, at the repository root rather than inside this
directory because that is the only place GitHub reads workflows from, runs the checks on every push
and pull request and deploys when `main` moves. Both triggers are filtered on
`projects/pdf-semantic-finder/**`, so another project in this repository neither runs this suite nor
deploys this site, and every step runs with `working-directory: projects/pdf-semantic-finder`.

### 12.1 What it runs

`npx prettier --check .`, then `npm run fixtures:sample` (the suites skip loudly without the
fixtures, and a skipped suite is a green run that proves nothing), then
`npx playwright install --with-deps chromium`, then `npm run verify` — assets, typecheck, unit
tests, end-to-end. The end-to-end half brings up both servers, including the `wrangler dev` preview
that §5.3's headers are actually asserted against.

Only then, and only on a push to `main`, `npm run build && npx wrangler deploy`, using the wrangler
pinned in this project's lockfile so the version that deploys is the version the checks ran against.

### 12.2 What it deliberately does not run

- **Secrets are never uploaded.** `TYPESAFE_API_KEY` is set once with `wrangler secret put` (§3.2)
  and persists across deploys; a deploy neither reads nor rewrites it. So a leaked CI token can
  deploy code, but cannot read the provider credential.
- **The evaluation set does not run.** `npm run eval` calls the real provider and costs money per
  run. It stays a deliberate local command.
- **Nothing in §5 is automated.** The rate limit, the provider budget and the deployed headers are
  checked against the real deployment, by hand, after the deploy.

### 12.3 The token, and what it may do

Create an API token from Cloudflare's **Edit Cloudflare Workers** template — Workers Scripts:Edit on
the account plus Workers Routes:Edit on the zone, which is what a custom-domain deploy needs. Scope
it to the one account and the `kourin.jp` zone. Check the template's current permission list against
Cloudflare's documentation rather than against this paragraph; the templates change.

Then, in `jev-playground`'s Settings → Secrets and variables → Actions:

```
CLOUDFLARE_API_TOKEN     the token above
CLOUDFLARE_ACCOUNT_ID    npx wrangler whoami
```

On a public repository these are not exposed to workflow runs from forked pull requests, and the
deploy job is additionally gated on `github.event_name == 'push' && github.ref == 'refs/heads/main'`.
Both matter: the gate is the one that stops a pull request from deploying, the fork rule is the one
that stops it from reading the token.

### 12.4 After it is automatic

Rollback stays manual (§6) and so does verification (§5). A deploy that goes out automatically is
still a deploy that changes what strangers see, so treat a merge to `main` as the release decision
it now is — there is no separate approval step between the merge and the public site, by design,
because a step nobody performs is worse than no step at all.

The one recurring failure to expect is the cold-start race in §3.1. The workflow retries an
end-to-end test once on CI for exactly that reason and for no other. A test that fails twice is a
real failure.
