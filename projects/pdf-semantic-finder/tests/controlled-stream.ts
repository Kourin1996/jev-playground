/**
 * A `/api/search` response the test releases one instalment at a time.
 *
 * Playwright's `route.fulfill` cannot hold a body open, and several behaviours exist only while one
 * is: the provisional list, the note saying the order may still change, and everything about what
 * happens when the reader acts before the final line arrives. So `fetch` is replaced inside the
 * page, and the application's own client is what consumes the stream.
 */
import type { Page } from "@playwright/test";

export type StreamedResult = { segmentId: string; score: number; relevantProbability: number; confidence: number };

declare global {
    interface Window {
        /** Emits the next queued progress line. */
        releaseNextProgress: () => void;
        /** Emits the final line and closes the stream. */
        releaseFinalLine: () => void;
    }
}

export type ControlledStreamOptions = {
    /**
     * Each progress instalment, as positions into the request's segments.
     *
     * The first is sent as soon as the request arrives; the rest wait for `releaseNextProgress`, so
     * a test can act on one ranking and then watch what a later one does to it.
     */
    provisional: number[][];
    /** Which of them the final ranking names, in order. */
    final: number[];
    status?: string;
};

export const installControlledStream = async (page: Page, options: ControlledStreamOptions): Promise<void> => {
    await page.addInitScript((config: ControlledStreamOptions) => {
        const realFetch = window.fetch.bind(window);
        let release: (() => void) | null = null;
        window.releaseFinalLine = () => release?.();

        window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!url.includes("/api/search")) return realFetch(input, init);

            const body = JSON.parse(String(init?.body ?? "{}")) as { documentId: string; requestId: string; segments: { id: string }[] };
            const encoder = new TextEncoder();
            const line = (message: unknown) => encoder.encode(`${JSON.stringify(message)}\n`);
            const record = (position: number, rank: number) => ({
                segmentId: body.segments[position].id,
                score: 2 - rank * 0.2,
                relevantProbability: 0.95 - rank * 0.1,
                confidence: 0.8,
            });

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    const frames = [...config.provisional];
                    const sendProgress = (positions: number[], index: number) =>
                        controller.enqueue(
                            line({
                                type: "progress",
                                documentId: body.documentId,
                                requestId: body.requestId,
                                evaluated: index + 1,
                                total: body.segments.length,
                                results: positions.map(record),
                            }),
                        );

                    let sent = 0;
                    const first = frames.shift();
                    if (first !== undefined) sendProgress(first, sent++);

                    window.releaseNextProgress = () => {
                        const next = frames.shift();
                        if (next !== undefined) sendProgress(next, sent++);
                    };

                    release = () => {
                        controller.enqueue(
                            line({
                                type: "final",
                                documentId: body.documentId,
                                requestId: body.requestId,
                                status: config.status ?? "matched",
                                results: config.final.map(record),
                                evaluatedSegmentCount: body.segments.length,
                                requestCount: 2,
                                model: "jev-1.13.0",
                                elapsedMs: 120,
                            }),
                        );
                        controller.close();
                    };
                },
            });

            return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
        };
    }, options);
};

/** Releases the next queued progress line. */
export const releaseNextProgress = (page: Page): Promise<void> => page.evaluate(() => window.releaseNextProgress());

/** Releases the final line, ending the search. */
export const releaseFinalLine = (page: Page): Promise<void> => page.evaluate(() => window.releaseFinalLine());
