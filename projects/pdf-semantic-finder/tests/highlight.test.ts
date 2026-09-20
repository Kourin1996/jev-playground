/**
 * Highlight target resolution (spec §8).
 *
 * The point of this module is to refuse to guess, so the failure branches are what matter here.
 * A DOM is not needed: the resolver only reads `classList` and `isConnected`.
 */
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { describe, expect, it } from "vitest";
import { HIGHLIGHT_CLASS, applyHighlight, clearHighlight, resolveHighlightTargets } from "@/lib/pdf/highlight";
import type { RenderedTextLayer } from "@/lib/pdf/highlight";

const element = (isConnected = true) => {
    const classes = new Set<string>();
    return {
        isConnected,
        classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
        },
        has: (name: string) => classes.has(name),
    } as unknown as HTMLElement & { has: (name: string) => boolean };
};

const textContent = (strings: string[]) => ({ items: strings.map((str) => ({ str })), styles: {}, lang: null }) as unknown as TextContent;

const layer = (strings: string[], elements: HTMLElement[]): RenderedTextLayer => ({
    textDivs: elements,
    textContentItemsStr: strings,
});

describe("resolveHighlightTargets", () => {
    it("resolves the elements for the given item indexes", () => {
        const strings = ["第4条", "中途解約", "の場合"];
        const elements = strings.map(() => element());
        const resolved = resolveHighlightTargets(layer(strings, elements), textContent(strings), [0, 2], true);

        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.elements).toEqual([elements[0], elements[2]]);
    });

    it("refuses while the layer has not finished rendering", () => {
        const strings = ["本文"];
        const resolved = resolveHighlightTargets(layer(strings, [element()]), textContent(strings), [0], false);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("layer_not_ready");
    });

    it("refuses when the element count does not match the item count", () => {
        // What a truncated text layer looks like; every index past the cut would be wrong.
        const strings = ["a", "b", "c"];
        const resolved = resolveHighlightTargets(layer(strings, [element(), element()]), textContent(strings), [0], true);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) {
            expect(resolved.failure.reason).toBe("element_count_mismatch");
            if (resolved.failure.reason === "element_count_mismatch") {
                expect(resolved.failure).toMatchObject({ expected: 3, actual: 2 });
            }
        }
    });

    it("refuses when the layer was built from different text than extraction used", () => {
        // A length check alone would pass here, and the highlight would land on the wrong words.
        const elements = [element(), element()];
        const resolved = resolveHighlightTargets(layer(["別の", "文章"], elements), textContent(["中途", "解約"]), [1], true);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("content_mismatch");
    });

    it("refuses an item index that is out of range", () => {
        const strings = ["本文"];
        const resolved = resolveHighlightTargets(layer(strings, [element()]), textContent(strings), [5], true);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("content_mismatch");
    });

    it("skips elements PDF.js never inserted into the DOM", () => {
        // Items with an empty string get an element that carries no visible text.
        const strings = ["見出し", "", "本文"];
        const elements = [element(true), element(false), element(true)];
        const resolved = resolveHighlightTargets(layer(strings, elements), textContent(strings), [0, 1, 2], true);

        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.elements).toEqual([elements[0], elements[2]]);
    });
});

describe("applyHighlight and clearHighlight", () => {
    it("applies and removes the class", () => {
        const first = element();
        const second = element();
        const applied = applyHighlight([first, second]);

        expect(applied).toHaveLength(2);
        expect((first as never as { has: (n: string) => boolean }).has(HIGHLIGHT_CLASS)).toBe(true);

        clearHighlight(applied);
        expect((first as never as { has: (n: string) => boolean }).has(HIGHLIGHT_CLASS)).toBe(false);
    });

    it("does not use the class PDF.js already styles for its own find controller", () => {
        expect(HIGHLIGHT_CLASS).not.toBe("highlight");
    });
});
