/**
 * Cross-origin admission for the application API (spec §9.1).
 *
 * `/api/search` is served from the same origin as the page, so nothing legitimate posts to it from
 * anywhere else. Without this check any web page could: the Worker sends no CORS headers, but a
 * request whose content type is CORS-safelisted needs no preflight, so the *request* still happens
 * and still spends provider budget even though the attacker cannot read the response.
 *
 * `Sec-Fetch-Site` is the modern signal and `Origin` the portable one; both are set by the browser
 * and cannot be forged by page script. A non-browser client sends neither, and is allowed — this
 * bounds abuse through a visitor's browser, not abuse in general. That is what §1.2's rate limit
 * and budget are for.
 */
export const isSameOriginRequest = (headers: Pick<Headers, "get">, requestUrl: string): boolean => {
    const site = headers.get("Sec-Fetch-Site");
    if (site !== null) return site === "same-origin" || site === "none";

    const origin = headers.get("Origin");
    if (origin === null) return true;

    try {
        return new URL(origin).origin === new URL(requestUrl).origin;
    } catch {
        return false;
    }
};
