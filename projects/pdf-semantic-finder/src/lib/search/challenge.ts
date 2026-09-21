/**
 * The browser half of the Turnstile gate (spec §9.3).
 *
 * The Worker decides whether a search is admitted; this only obtains the token it asks for. So
 * everything here is best-effort: if the widget is not configured, or its script does not load, or
 * the challenge does not resolve, the search is sent without a token and the Worker answers. A
 * client-side failure must never be the thing that decides admission.
 *
 * **Lazily, and not before.** Nothing is fetched or loaded until a meaning search is about to run,
 * so opening a PDF and searching it exactly still make no request at all — the property §14.30's
 * cost model rests on, and the reason the sitekey is not fetched at start-up.
 */

/** Only the parts of the widget API this module uses. */
type TurnstileApi = {
    render: (
        container: HTMLElement,
        options: {
            sitekey: string;
            execution?: "render" | "execute";
            appearance?: "always" | "execute" | "interaction-only";
            callback: (token: string) => void;
            "error-callback"?: (code?: string) => void;
            "timeout-callback"?: () => void;
        },
    ) => string;
    execute: (widget: string) => void;
    remove: (widget: string) => void;
};

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * How long a challenge may take before the search goes without one.
 *
 * The Worker still refuses an unverified search, so this is not a way past the gate — it is what
 * stops a widget that never answers from holding a search open until the reader gives up. The
 * error the reader then sees says the search was not verified, which is what happened.
 */
const CHALLENGE_TIMEOUT_MS = 10_000;

/** Asked once per page load; the answer does not change under a reader. */
let sitekeyPromise: Promise<string | null> | null = null;

const readSitekey = (): Promise<string | null> => {
    sitekeyPromise ??= (async () => {
        try {
            const response = await fetch("/api/config");
            if (!response.ok) return null;
            const payload: unknown = await response.json();
            if (typeof payload !== "object" || payload === null) return null;
            const { turnstileSitekey } = payload as { turnstileSitekey?: unknown };
            return typeof turnstileSitekey === "string" && turnstileSitekey !== "" ? turnstileSitekey : null;
        } catch {
            return null;
        }
    })();

    return sitekeyPromise;
};

let scriptPromise: Promise<TurnstileApi | null> | null = null;

const loadTurnstile = (): Promise<TurnstileApi | null> => {
    scriptPromise ??= new Promise<TurnstileApi | null>((resolve) => {
        if (window.turnstile !== undefined) {
            resolve(window.turnstile);
            return;
        }

        const script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
        script.addEventListener("load", () => resolve(window.turnstile ?? null), { once: true });
        script.addEventListener("error", () => resolve(null), { once: true });
        document.head.append(script);
    });

    return scriptPromise;
};

/**
 * Obtains one token, or null if the challenge could not be completed.
 *
 * A fresh widget per search rather than one that is reset between them: a Turnstile token is valid
 * once and for five minutes, so each search needs its own, and rendering afresh keeps this module
 * free of the reset lifecycle rather than getting it subtly wrong.
 */
export const obtainChallengeToken = async (signal?: AbortSignal): Promise<string | null> => {
    const sitekey = await readSitekey();
    if (sitekey === null) return null;

    const turnstile = await loadTurnstile();
    if (turnstile === null) return null;

    // Off-screen rather than hidden: `display: none` stops the widget running at all, and an
    // invisible widget still has to be in the document to execute.
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);

    let widget: string | null = null;

    try {
        return await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), CHALLENGE_TIMEOUT_MS);
            const finish = (token: string | null) => {
                clearTimeout(timer);
                resolve(token);
            };

            signal?.addEventListener("abort", () => finish(null), { once: true });

            try {
                widget = turnstile.render(container, {
                    sitekey,
                    execution: "execute",
                    appearance: "interaction-only",
                    callback: (token) => finish(token),
                    "error-callback": () => finish(null),
                    "timeout-callback": () => finish(null),
                });
                turnstile.execute(widget);
            } catch {
                finish(null);
            }
        });
    } finally {
        if (widget !== null) {
            try {
                turnstile.remove(widget);
            } catch {
                // Removing a widget that already tore itself down is not a failure worth reporting.
            }
        }
        container.remove();
    }
};
