/**
 * Batching, retry, and deadline behaviour (spec §6.4).
 *
 * `fetch`, the clock, and sleeping are injected, so none of this touches a network.
 */
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/lib/types";
import { buildJevRequest } from "../worker/search/build-jev-request";
import { callJevBatch, callJevBatches } from "../worker/search/call-jev";
import type { CallJevDependencies } from "../worker/search/call-jev";

const okAnswer = (segmentId: string) => ({
    [`relevance_${segmentId.replace("-", "_")}`]: {
        type: "score",
        score: 1.8,
        confidence: 0.8,
        probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
    },
});

const okBody = (segmentIds: string[]) => ({
    model: "jev-1.13.0",
    answers: Object.assign({}, ...segmentIds.map(okAnswer)),
    usage: { input_tokens: 100, output_tokens: 10 },
});

const requestFor = (segmentIds: string[]) => {
    const segments = segmentIds.map((id) => ({ id, text: "中途解約の場合、既払料金の返還は行わない。" }));
    return buildJevRequest("jev-1.13.0", "途中でやめたら、お金は戻る？", { evaluate: segments, state: segments });
};

const dependencies = (fetchImpl: typeof globalThis.fetch, overrides: Partial<CallJevDependencies> = {}): CallJevDependencies => ({
    fetch: fetchImpl,
    now: () => 0,
    sleep: async () => undefined,
    apiKey: "test-key",
    model: "jev-1.13.0",
    deadlineAt: 15_000,
    ...overrides,
});

describe("callJevBatch", () => {
    it("expects one answer per question, not one per passage in the state", () => {
        // A batch's state is padded to a uniform size, so it carries passages no question was
        // asked about. Counting the state instead failed every padded request as a malformed
        // response — and no end-to-end test could see it, because they all intercept /api/search.
        const evaluated = { id: "p001-s001", text: "中途解約の場合、既払料金の返還は行わない。" };
        const padding = [
            { id: "p001-s002", text: "本契約は甲乙間の合意により成立する。" },
            { id: "p001-s003", text: "甲は乙に対し利用案内を交付する。" },
        ];
        const request = buildJevRequest("jev-1.13.0", "途中でやめたら、お金は戻る？", { evaluate: [evaluated], state: [evaluated, ...padding] });

        expect(Object.keys(request.state.passages)).toHaveLength(3);
        expect(Object.keys(request.questions)).toHaveLength(1);

        const fetchImpl = vi.fn(async () => Response.json(okBody(["p001-s001"])));

        return callJevBatch(request, dependencies(fetchImpl as never)).then((outcome) => {
            expect(outcome.ok).toBe(true);
            if (outcome.ok) expect([...outcome.answers.keys()]).toEqual(["p001-s001"]);
        });
    });

    it("returns one answer per requested segment", async () => {
        const fetchImpl = vi.fn(async () => Response.json(okBody(["p001-s001", "p001-s002"])));
        const outcome = await callJevBatch(requestFor(["p001-s001", "p001-s002"]), dependencies(fetchImpl as never));

        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect([...outcome.answers.keys()].sort()).toEqual(["p001-s001", "p001-s002"]);
            expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
        }
    });

    it("sends the credential as a bearer token and nothing else", async () => {
        const fetchImpl = vi.fn(async () => Response.json(okBody(["p001-s001"])));
        await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never));

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    });

    it("treats a missing answer as a malformed response, not a segment that scored zero", async () => {
        const fetchImpl = vi.fn(async () => Response.json(okBody(["p001-s001"])));
        const outcome = await callJevBatch(requestFor(["p001-s001", "p001-s002"]), dependencies(fetchImpl as never));

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_malformed_response");
    });

    it("retries once after a transient failure and then succeeds", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response("", { status: 503 }))
            .mockResolvedValueOnce(Response.json(okBody(["p001-s001"])));

        const outcome = await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never));

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(outcome.ok).toBe(true);
    });

    it("retries at most once", async () => {
        const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
        const outcome = await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never));

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_unavailable");
    });

    it("retries an overloaded provider", async () => {
        // 529 is TypeSafe's "overloaded, try again". Treating it as fatal turns a momentary
        // overload into a failed search, which is the one outcome this project must not confuse
        // with "nothing was found".
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
            .mockResolvedValueOnce(Response.json(okBody(["p001-s001"])));

        const outcome = await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never));

        expect(outcome.ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-retryable status", async () => {
        const fetchImpl = vi.fn(async () => new Response("", { status: 400 }));
        await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never));

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("honours Retry-After when it fits inside the deadline", async () => {
        const sleep = vi.fn(async () => undefined);
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
            .mockResolvedValueOnce(Response.json(okBody(["p001-s001"])));

        await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never, { sleep }));

        expect(sleep).toHaveBeenCalledWith(2000, undefined);
    });

    it("fails rather than sleeping past the deadline", async () => {
        const sleep = vi.fn(async () => undefined);
        const fetchImpl = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "30" } }));

        const outcome = await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never, { sleep, now: () => 9_000, deadlineAt: 15_000 }));

        expect(sleep).not.toHaveBeenCalled();
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_timeout");
    });

    it("does not start a request once the deadline has passed", async () => {
        const fetchImpl = vi.fn(async () => Response.json(okBody(["p001-s001"])));
        const outcome = await callJevBatch(requestFor(["p001-s001"]), dependencies(fetchImpl as never, { now: () => 20_000 }));

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_timeout");
    });
});

describe("callJevBatches", () => {
    it("merges answers across batches", async () => {
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string) as { state: { passages: Record<string, unknown> } };
            return Response.json(okBody(Object.keys(body.state.passages)));
        });

        const outcome = await callJevBatches([requestFor(["p001-s001"]), requestFor(["p001-s002"])], dependencies(fetchImpl as never));

        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.answers.size).toBe(2);
    });

    it("fails the whole search when one batch fails, rather than reporting no match", async () => {
        // Spec §6.4: partial evaluation must never be presented as an absence of relevant text.
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string) as { state: { passages: Record<string, unknown> } };
            const ids = Object.keys(body.state.passages);
            if (ids.includes("p001-s002")) return new Response("", { status: 500 });
            return Response.json(okBody(ids));
        });

        const outcome = await callJevBatches([requestFor(["p001-s001"]), requestFor(["p001-s002"])], dependencies(fetchImpl as never));

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe("provider_unavailable");
    });

    it("runs no more than the configured number of requests at once", async () => {
        let active = 0;
        let peak = 0;

        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;

            const body = JSON.parse(init.body as string) as { state: { passages: Record<string, unknown> } };
            return Response.json(okBody(Object.keys(body.state.passages)));
        });

        const requests = Array.from({ length: LIMITS.maxConcurrentRequests * 2 + 1 }, (_, index) =>
            requestFor([`p001-s${String(index + 1).padStart(3, "0")}`]),
        );
        await callJevBatches(requests, dependencies(fetchImpl as never));

        // Both directions: the pool must hold the line, and it must actually fill — an assertion
        // on the ceiling alone would also pass if the requests ran one at a time.
        expect(peak).toBe(LIMITS.maxConcurrentRequests);
    });
});
