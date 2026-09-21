/**
 * Response headers for anything this Worker serves to a browser (spec §10).
 *
 * **These do not cover most asset responses.** `wrangler.jsonc` does not set `run_worker_first`, so
 * Cloudflare's asset router answers `/index.html` and `/assets/*` without invoking this Worker at
 * all; `env.ASSETS.fetch` runs only for the single-page-application fallback. `public/_headers`
 * carries the same policy for the responses that never reach here, and the two must be kept
 * identical — this module is not the whole story on its own.
 *
 * The policy below is written against what this application actually loads, and
 * `tests/headers.spec.ts` opens a PDF, zooms it and searches it against a built preview while
 * asserting the console stays clear. A policy nobody exercised against the real viewer is a policy
 * that breaks the product.
 *
 * Each directive earns its place:
 *
 * - `'wasm-unsafe-eval'` — PDF.js ships WebAssembly under `/pdfjs/wasm/` for image codecs such as
 *   JPEG 2000, and WebAssembly instantiation is governed by `script-src`. **Precautionary, and not
 *   demonstrated:** removing it leaves every fixture in this repository working, because none of
 *   them contains an image that reaches that path. It stays because a reader's PDF may, and the
 *   failure would be a page that silently renders wrong. Anyone tightening this should first add a
 *   fixture that exercises the codec, not simply delete the directive because the suite stays
 *   green.
 * - `worker-src 'self' blob:` — the PDF.js worker is emitted same-origin by the bundler, and
 *   `blob:` covers its fallback of constructing the worker from a blob URL.
 * - `style-src 'unsafe-inline'` — not removable by a nonce. The text layer positions every span
 *   with an inline `style` attribute, which nonces do not cover, and react-aria injects more.
 * - `font-src` and part of `style-src` — the Inter stylesheet and its font files, from Google.
 * - `connect-src 'self'` — every request the page makes is same-origin: `/api/search`, and
 *   PDF.js's CMaps, WASM, ICC profiles and standard fonts under `/pdfjs/`. **The browser never
 *   contacts the provider**; the Worker does. That absence is itself a check on the architecture
 *   boundary — if this ever needs a provider host, something has moved to the wrong side.
 * - `script-src`/`frame-src https://challenges.cloudflare.com` — Turnstile (spec §9.3). It loads
 *   its script from that host and runs the widget in an iframe from it, and `frame-src` has to be
 *   named explicitly because it would otherwise fall back to `default-src 'self'`. `connect-src`
 *   is untouched: the widget talks to its own frame, not to the page, so the boundary the
 *   `connect-src 'self'` note below describes still holds.
 * - `form-action 'none'` — the search form never navigates; it is submitted through JavaScript and
 *   prevented. If the script fails, the fallback navigation is blocked rather than leaking the
 *   query into a URL.
 */

const CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' blob: data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Set on every response, and safe on every response: none of them can break a working page. */
const SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    // `frame-ancestors` above says this too; this is what the oldest browsers honour.
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // The app reads a local file the reader chose and nothing else.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

/**
 * Copies a response so headers can be added to it.
 *
 * Responses from the asset binding are immutable, so this rebuilds rather than mutates. A 204 or
 * 304 must be rebuilt without a body or the runtime rejects it.
 */
export const withSecurityHeaders = (response: Response): Response => {
    const bodyless = response.status === 204 || response.status === 304;
    const copy = new Response(bodyless ? null : response.body, response);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value);
    return copy;
};
