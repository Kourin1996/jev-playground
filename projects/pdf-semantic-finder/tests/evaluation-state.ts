/**
 * When a measured search is finished, and what it decided (spec §11.1).
 *
 * Separate from `run-evaluation.ts` because that file runs on import. These two functions are the
 * part of the harness that was wrong, so they are the part that has to be testable: the harness
 * used to resolve as soon as any result appeared, and to infer the verdict from a sentence in the
 * panel that is suppressed while a search is running.
 */

/** The authoritative outcome of one search, taken from the response rather than from the screen. */
export type SearchOutcome = { kind: "final"; status: string } | { kind: "error"; code: string } | { kind: "unreadable"; reason: string };

/**
 * Reads the terminal message out of a streamed NDJSON body.
 *
 * Progress lines are skipped; the conclusion is the only line that may move a metric. Scanned
 * forward, taking the **first** terminal line, because that is what the client does — it stops
 * reading there — and a harness that scored a different line from the one the reader was shown
 * would be measuring something nobody saw.
 *
 * Note for anyone reaching for this from a browser test: the *application* consumes the stream and
 * cancels the reader when it is done, so the body is usually no longer available to anyone else.
 * The harness therefore reads the committed interface instead (`outcomeOfSettledPanel`), and this
 * function exists for bodies captured some other way.
 */
export const terminalOfBody = (text: string): SearchOutcome => {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

    for (const line of lines) {
        let message: { type?: string; status?: string; error?: { code?: string } };
        try {
            message = JSON.parse(line) as typeof message;
        } catch {
            continue;
        }

        if (message.type === "final" && typeof message.status === "string") return { kind: "final", status: message.status };
        if (message.type === "error") return { kind: "error", code: message.error?.code ?? "unknown" };
    }

    // A stream that stopped before saying anything conclusive is a search that did not finish.
    return { kind: "unreadable", reason: "no_terminal_line" };
};

/**
 * The verdict a **settled** panel is showing.
 *
 * Reading the interface is not the defect the review found — reading it *early* was. While a search
 * runs the panel withholds the verdict and labels its list provisional, so a status taken then was
 * a guess. `hasSettled` is what makes this safe, and the two belong together.
 *
 * `statusCode` is the HTTP status, which is available without consuming the body; an error that
 * arrived inside the stream has no status of its own and is named for what it is.
 */
export const outcomeOfSettledPanel = (bodyText: string, statusCode: number): SearchOutcome => {
    if (statusCode === 429) return { kind: "error", code: "rate_limited" };
    if (statusCode === 503) return { kind: "error", code: "capacity_exhausted" };
    if (statusCode !== 200) return { kind: "error", code: `http_${statusCode}` };

    if (/The search could not be completed/u.test(bodyText)) return { kind: "error", code: "stream_error" };
    // §7: a near miss is not offered, so `uncertain` and `no_match` both show an empty panel and
    // are told apart by what it says. `matched` is the only state with a list.
    if (/came close to the relevance threshold/u.test(bodyText)) return { kind: "final", status: "uncertain" };
    if (/met the relevance threshold|No matching text was found/u.test(bodyText)) return { kind: "final", status: "no_match" };
    if (/\d+ results?\b/u.test(bodyText)) return { kind: "final", status: "matched" };

    return { kind: "unreadable", reason: "no_verdict_on_screen" };
};

/**
 * True once the interface has committed a terminal state.
 *
 * While a search runs the panel shows a provisional list under a note saying the order may still
 * change, and it withholds any verdict. Waiting for that note to disappear is what separates "the
 * first passages arrived" from "this is the answer".
 *
 * Written against a body of text so it can be checked without a browser, and passed to
 * `page.waitForFunction` wrapped in a reader of `document.body.innerText`.
 */
export const hasSettled = (bodyText: string): boolean => {
    if (/passages judged|may still change/u.test(bodyText)) return false;
    return /No matching text was found|met the relevance threshold|The search could not be completed/u.test(bodyText) || /\d+ results?\b/u.test(bodyText);
};
