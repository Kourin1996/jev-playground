/**
 * What the quality harness treats as finished, and as the answer (spec §11.1).
 *
 * `npm run eval` needs a credential and a provider, so it cannot be part of `npm test`. Its two
 * decisions can be, and they are the two it was getting wrong: it resolved as soon as any result
 * appeared — under streaming, a ranking that was still changing — and it inferred the verdict from
 * a sentence the panel suppresses while a search is running, so an uncertain result read early was
 * scored as a match and tallied as a false positive.
 */
import { describe, expect, it } from "vitest";
import { hasSettled, outcomeOfSettledPanel, terminalOfBody } from "./evaluation-state";

const line = (message: unknown) => `${JSON.stringify(message)}\n`;

const progress = (evaluated: number, segmentId: string) => ({
    type: "progress",
    documentId: "doc-1",
    requestId: "req-1",
    evaluated,
    total: 12,
    results: [{ segmentId, score: 1.4, relevantProbability: 0.44, confidence: 0.3 }],
});

const final = (status: string, segmentId: string) => ({
    type: "final",
    documentId: "doc-1",
    requestId: "req-1",
    status,
    results: [{ segmentId, score: 2, relevantProbability: 0.97, confidence: 0.9 }],
    evaluatedSegmentCount: 12,
    requestCount: 3,
    model: "jev-1.13.0",
    elapsedMs: 120,
});

describe("terminalOfBody", () => {
    it("takes the final line, not the first result to arrive", () => {
        // The scenario the review asks for: a provisional wrong match, then a correct final
        // ranking. Only the second may move a metric.
        const body = line(progress(4, "p001-s003")) + line(progress(8, "p001-s003")) + line(final("matched", "p002-s001"));

        expect(terminalOfBody(body)).toEqual({ kind: "final", status: "matched" });
    });

    it("reports uncertain as uncertain rather than as a match", () => {
        // A no-answer query that comes back `uncertain` is an acceptable hedge; scoring it as
        // `matched` counts a false positive that did not happen.
        expect(terminalOfBody(line(final("uncertain", "p001-s001")))).toEqual({ kind: "final", status: "uncertain" });
        expect(terminalOfBody(line(final("no_match", "p001-s001")))).toEqual({ kind: "final", status: "no_match" });
    });

    it("reports an error that arrived after progress, and names its code", () => {
        // A provider failure is neither a miss nor a false positive. Folding it into either would
        // blame the ranking for an outage.
        const body = line(progress(4, "p001-s003")) + line({ type: "error", documentId: "doc-1", requestId: "req-1", error: { code: "provider_timeout" } });

        expect(terminalOfBody(body)).toEqual({ kind: "error", code: "provider_timeout" });
    });

    it("takes the first conclusion, which is the one the reader was shown", () => {
        // The client stops at the first terminal line. Scoring a later one would measure something
        // that never reached the screen.
        const body = line(final("matched", "p002-s001")) + line(final("no_match", "p001-s001"));

        expect(terminalOfBody(body)).toEqual({ kind: "final", status: "matched" });
    });

    it("reports a stream that stopped before it concluded", () => {
        expect(terminalOfBody(line(progress(4, "p001-s003")))).toEqual({ kind: "unreadable", reason: "no_terminal_line" });
        expect(terminalOfBody("")).toEqual({ kind: "unreadable", reason: "no_terminal_line" });
        expect(terminalOfBody("not json\n")).toEqual({ kind: "unreadable", reason: "no_terminal_line" });
    });
});

describe("outcomeOfSettledPanel", () => {
    /*
     * Reading the interface is not the defect the review found — reading it *early* was. These
     * cases are what a settled panel says, and they are only sound because `hasSettled` gates them.
     */
    const list = "3 results\n1. Page 3\n第4条（中途解約）…";

    it("separates a confident match from a hedged one", () => {
        expect(outcomeOfSettledPanel(list, 200)).toEqual({ kind: "final", status: "matched" });
        expect(outcomeOfSettledPanel(`${list}\nThese passages may be related. Review them before relying on them.`, 200)).toEqual({
            kind: "final",
            status: "uncertain",
        });
    });

    it("reads an empty result as no match, not as an error", () => {
        expect(outcomeOfSettledPanel("No passage in the extracted text met the relevance threshold.", 200)).toEqual({ kind: "final", status: "no_match" });
    });

    it("names an admission refusal by its status, without reading the body", () => {
        // The body of a refusal is JSON the application has already consumed; the status is not.
        expect(outcomeOfSettledPanel("", 429)).toEqual({ kind: "error", code: "rate_limited" });
        expect(outcomeOfSettledPanel("", 503)).toEqual({ kind: "error", code: "capacity_exhausted" });
        expect(outcomeOfSettledPanel("", 502)).toEqual({ kind: "error", code: "http_502" });
    });

    it("reads a failure that arrived inside the stream as an error, not a miss", () => {
        expect(outcomeOfSettledPanel("The search could not be completed", 200)).toEqual({ kind: "error", code: "stream_error" });
    });
});

describe("hasSettled", () => {
    /** The two sentences the results panel shows while a meaning search is still running. */
    const running = "3 results\nReading the document — 8 of 12 passages judged.\nThese are the best so far and may still change.";

    it("is false while the panel says the order may still change", () => {
        expect(hasSettled(running)).toBe(false);
    });

    it("is true once the verdict is committed", () => {
        expect(hasSettled("3 results\n1. Page 3\n第4条（中途解約）…")).toBe(true);
        expect(hasSettled("No passage in the extracted text met the relevance threshold.")).toBe(true);
        expect(hasSettled("No matching text was found in the extracted text.")).toBe(true);
        expect(hasSettled("The search could not be completed")).toBe(true);
    });

    it("is false before a search has produced anything at all", () => {
        // Otherwise the harness would read the previous query's results as this query's answer.
        expect(hasSettled("Enter a query to search this document.")).toBe(false);
    });
});
