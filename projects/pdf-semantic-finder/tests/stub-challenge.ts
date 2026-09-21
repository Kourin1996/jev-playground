/**
 * Takes the Turnstile gate out of the browser tests (spec §9.3).
 *
 * The specs that exercise meaning search intercept `/api/search` and answer it themselves, so the
 * Worker's half of the gate never runs. The **client's** half would still run: it asks
 * `/api/config` for a sitekey and, given one, loads a script from `challenges.cloudflare.com`.
 * That would make a suite that is otherwise entirely local depend on the network and on a third
 * party's availability.
 *
 * So the config endpoint is answered here with no sitekey, which is the documented way to say the
 * widget is not configured, and the client skips the challenge. What this gives up is coverage of
 * the client's challenge path; `tests/turnstile.test.ts` covers the decision that actually admits
 * a search, and only a deployed check can cover the widget itself.
 */
import type { Page } from "@playwright/test";

export const stubChallenge = async (page: Page): Promise<void> => {
    await page.route("**/api/config", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ turnstileSitekey: null }) });
    });
};
