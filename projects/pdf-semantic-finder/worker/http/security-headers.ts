/**
 * Response headers for anything this Worker serves to a browser (spec §10).
 *
 * **These do not cover most asset responses.** `wrangler.jsonc` does not set `run_worker_first`, so
 * Cloudflare's asset router answers `/index.html` and `/assets/*` without invoking this Worker at
 * all; `env.ASSETS.fetch` runs only for the single-page-application fallback. `public/_headers`
 * carries the same policy for the responses that never reach here, and the two must be kept
 * identical — this module is not the whole story on its own.
 *
 * The `Content-Security-Policy` proper is deliberately not here yet. It has to be written against
 * what PDF.js actually loads — WebAssembly, a worker that may be a blob, and a text layer that
 * positions every span through an inline style — and a policy that has not been exercised against
 * the real viewer is a policy that breaks the product. It arrives with the test that opens a PDF
 * and asserts no violation.
 */

/** Set on every response, and safe on every response: none of them can break a working page. */
const SECURITY_HEADERS = {
    // The document is never framed. `frame-ancestors` will restate this once the CSP lands; this
    // header is what every browser honours today.
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
