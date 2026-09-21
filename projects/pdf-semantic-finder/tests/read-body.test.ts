/**
 * Bounded request-body reading (spec §9.3).
 *
 * The point of every case here is *when* the limit applies, not only that it applies: the Worker
 * used to buffer and parse the whole body before measuring it, so a rejection that happens after
 * the allocation is not a fix.
 */
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/types";
import { declaredLengthExceeds, isJsonMediaType, readBoundedJson } from "../worker/http/read-body";

const headersOf = (entries: Record<string, string>) => new Headers(entries);

/** A body delivered in the given chunks, recording how many were actually pulled. */
const streamOf = (chunks: readonly Uint8Array[]) => {
    const pulled: number[] = [];
    let index = 0;

    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index >= chunks.length) {
                controller.close();
                return;
            }
            pulled.push(index);
            controller.enqueue(chunks[index]);
            index += 1;
        },
    });

    return { body, pulled };
};

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("isJsonMediaType", () => {
    it("accepts application/json with and without parameters", () => {
        expect(isJsonMediaType("application/json")).toBe(true);
        expect(isJsonMediaType("application/json; charset=utf-8")).toBe(true);
        expect(isJsonMediaType("  APPLICATION/JSON  ")).toBe(true);
    });

    it("rejects a safelisted type that merely contains application/json", () => {
        // The whole reason this function exists. `text/plain` is CORS-safelisted, so a substring
        // test let any web page post to /api/search from a visitor's browser with no preflight.
        expect(isJsonMediaType("text/plain; application/json")).toBe(false);
        expect(isJsonMediaType("application/jsonx")).toBe(false);
        expect(isJsonMediaType("multipart/form-data")).toBe(false);
        expect(isJsonMediaType(null)).toBe(false);
    });
});

describe("declaredLengthExceeds", () => {
    it("rejects only a well-formed length above the limit", () => {
        expect(declaredLengthExceeds("101", 100)).toBe(true);
        expect(declaredLengthExceeds("100", 100)).toBe(false);
        expect(declaredLengthExceeds(null, 100)).toBe(false);
        // Malformed or negative is ignored rather than trusted in either direction; the bytes that
        // actually arrive are the real check.
        expect(declaredLengthExceeds("not-a-number", 100)).toBe(false);
        expect(declaredLengthExceeds("-5", 100)).toBe(false);
    });
});

describe("readBoundedJson", () => {
    const read = (chunks: readonly Uint8Array[], headers: Record<string, string> = {}, maxBytes = 64) => {
        const { body, pulled } = streamOf(chunks);
        return { pulled, outcome: readBoundedJson({ headers: headersOf({ "Content-Type": "application/json", ...headers }), body }, { maxBytes }) };
    };

    it("parses a body at exactly the limit", async () => {
        const payload = utf8(JSON.stringify({ a: "x".repeat(10) }));
        const { outcome } = read([payload], {}, payload.byteLength);

        expect(await outcome).toEqual({ ok: true, value: { a: "x".repeat(10) }, byteLength: payload.byteLength });
    });

    it("rejects one byte over the limit and stops reading there", async () => {
        const first = utf8("x".repeat(64));
        const second = utf8("y");
        const third = utf8("z");
        const { pulled, outcome } = read([first, second, third], {}, 64);

        expect(await outcome).toEqual({ ok: false, code: "request_body_too_large" });
        // The third chunk was never pulled: the limit stops the upload rather than measuring it.
        expect(pulled).toEqual([0, 1]);
    });

    it("rejects on the declared length without acquiring a reader", async () => {
        const body = new ReadableStream<Uint8Array>();
        const getReader = vi.spyOn(body, "getReader");

        const outcome = await readBoundedJson({ headers: headersOf({ "Content-Type": "application/json", "Content-Length": "999" }), body }, { maxBytes: 64 });

        expect(outcome).toEqual({ ok: false, code: "request_body_too_large" });
        expect(getReader).not.toHaveBeenCalled();
    });

    it("still rejects on real bytes when the declared length lies", async () => {
        const { outcome } = read([utf8("x".repeat(200))], { "Content-Length": "10" }, 64);
        expect(await outcome).toEqual({ ok: false, code: "request_body_too_large" });
    });

    it("reassembles a supplementary character split across two chunks", async () => {
        // 𠮟 is four UTF-8 bytes. Decoding each chunk independently would corrupt it, and the
        // repository's whole exact-search contract depends on such characters surviving intact.
        const whole = utf8(JSON.stringify({ text: "𠮟責" }));
        const split = whole.byteLength - 6;
        const { outcome } = read([whole.slice(0, split), whole.slice(split)], {}, 128);

        expect(await outcome).toEqual({ ok: true, value: { text: "𠮟責" }, byteLength: whole.byteLength });
    });

    it("rejects invalid UTF-8 rather than silently replacing it", async () => {
        const { outcome } = read([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])], {}, 64);
        expect(await outcome).toEqual({ ok: false, code: "invalid_request" });
    });

    it("rejects malformed JSON", async () => {
        const { outcome } = read([utf8("{ not json")], {}, 64);
        expect(await outcome).toEqual({ ok: false, code: "invalid_request" });
    });

    it("rejects a body whose media type is wrong before touching the stream", async () => {
        const body = new ReadableStream<Uint8Array>();
        const getReader = vi.spyOn(body, "getReader");

        const outcome = await readBoundedJson({ headers: headersOf({ "Content-Type": "text/plain; application/json" }), body }, { maxBytes: 64 });

        expect(outcome).toEqual({ ok: false, code: "invalid_request" });
        expect(getReader).not.toHaveBeenCalled();
    });

    it("rejects a request with no body", async () => {
        const outcome = await readBoundedJson({ headers: headersOf({ "Content-Type": "application/json" }), body: null }, { maxBytes: 64 });
        expect(outcome).toEqual({ ok: false, code: "invalid_request" });
    });

    it("gives up on a body that never finishes arriving", async () => {
        // A `Date.now()` check inside the loop would not catch this: `read()` on a stalled
        // connection simply never resolves, so the wait itself has to be abortable.
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull() {
                return new Promise<void>(() => undefined);
            },
            cancel() {
                cancelled = true;
            },
        });

        const outcome = await readBoundedJson({ headers: headersOf({ "Content-Type": "application/json" }), body }, { maxBytes: 64, deadlineMs: 50 });

        expect(outcome).toEqual({ ok: false, code: "invalid_request" });
        expect(cancelled).toBe(true);
    });

    it("defaults to the declared body limit", async () => {
        const { body } = streamOf([utf8("{}")]);
        const outcome = await readBoundedJson({
            headers: headersOf({ "Content-Type": "application/json", "Content-Length": String(LIMITS.maxRequestBodyBytes + 1) }),
            body,
        });

        expect(outcome).toEqual({ ok: false, code: "request_body_too_large" });
    });
});
