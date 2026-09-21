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
import { wholeItemRange } from "@/lib/types";

/**
 * The parts of an element this module touches. Sub-range highlighting replaces children, so the
 * stand-in records what it was given rather than only which classes were toggled.
 */
type FakeElement = HTMLElement & {
    has: (name: string) => boolean;
    rendered: () => string;
    marked: () => string;
};

const element = (isConnected = true, text = ""): FakeElement => {
    const classes = new Set<string>();
    let children: Array<{ mark: boolean; text: string }> = [{ mark: false, text }];

    const node = {
        isConnected,
        classList: { add: (n: string) => classes.add(n), remove: (n: string) => classes.delete(n) },
        ownerDocument: {
            createElement: () => {
                const span = { className: "", textContent: "" };
                return span as unknown as HTMLElement;
            },
            createTextNode: (value: string) => ({ textContent: value }) as unknown as Text,
        },
        replaceChildren: (...nodes: Array<{ className?: string; textContent?: string }>) => {
            children = nodes.map((n) => ({ mark: n.className === HIGHLIGHT_CLASS, text: n.textContent ?? "" }));
        },
        set textContent(value: string) {
            children = [{ mark: false, text: value }];
        },
        get textContent() {
            return children.map((c) => c.text).join("");
        },
        has: (name: string) => classes.has(name),
        rendered: () => children.map((c) => c.text).join(""),
        marked: () =>
            children
                .filter((c) => c.mark)
                .map((c) => c.text)
                .join(""),
    };

    return node as unknown as FakeElement;
};

const textContent = (strings: string[]) => ({ items: strings.map((str) => ({ str })), styles: {}, lang: null }) as unknown as TextContent;

const layer = (strings: string[], elements: HTMLElement[]): RenderedTextLayer => ({
    textDivs: elements,
    textContentItemsStr: strings,
});

describe("resolveHighlightTargets", () => {
    it("resolves the elements for the given ranges", () => {
        const strings = ["第4条", "中途解約", "の場合"];
        const elements = strings.map((text) => element(true, text));
        const resolved = resolveHighlightTargets(layer(strings, elements), textContent(strings), [wholeItemRange(0), wholeItemRange(2)], true);

        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.targets.map((t) => t.element)).toEqual([elements[0], elements[2]]);
    });

    it("refuses while the layer has not finished rendering", () => {
        const strings = ["本文"];
        const resolved = resolveHighlightTargets(layer(strings, [element()]), textContent(strings), [wholeItemRange(0)], false);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("layer_not_ready");
    });

    it("refuses when the element count does not match the item count", () => {
        // What a truncated text layer looks like; every index past the cut would be wrong.
        const strings = ["a", "b", "c"];
        const resolved = resolveHighlightTargets(layer(strings, [element(), element()]), textContent(strings), [wholeItemRange(0)], true);

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
        const resolved = resolveHighlightTargets(layer(["別の", "文章"], elements), textContent(["中途", "解約"]), [wholeItemRange(1)], true);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("content_mismatch");
    });

    it("refuses an item index that is out of range", () => {
        const strings = ["本文"];
        const resolved = resolveHighlightTargets(layer(strings, [element()]), textContent(strings), [wholeItemRange(5)], true);

        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.failure.reason).toBe("content_mismatch");
    });

    it("skips elements PDF.js never inserted into the DOM", () => {
        // Items with an empty string get an element that carries no visible text.
        const strings = ["見出し", "", "本文"];
        const elements = [element(true, "見出し"), element(false, ""), element(true, "本文")];
        const resolved = resolveHighlightTargets(layer(strings, elements), textContent(strings), [0, 1, 2].map(wholeItemRange), true);

        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.targets.map((t) => t.element)).toEqual([elements[0], elements[2]]);
    });
});

describe("applyHighlight and clearHighlight", () => {
    it("marks a whole item with a class, and removes it again", () => {
        const first = element(true, "本文");
        const second = element(true, "続き");
        const applied = applyHighlight([
            { element: first, text: "本文", startOffset: 0, endOffset: 2, wholeItem: true },
            { element: second, text: "続き", startOffset: 0, endOffset: 2, wholeItem: true },
        ]);

        expect(applied).toHaveLength(2);
        expect(first.has(HIGHLIGHT_CLASS)).toBe(true);

        clearHighlight(applied);
        expect(first.has(HIGHLIGHT_CLASS)).toBe(false);
    });

    it("marks only the matched characters when the range is narrower than the item", () => {
        // Two occurrences inside one item have to be distinguishable; marking the whole element
        // would make Next appear to do nothing.
        const text = "返金条件は第4条。返金申請は書面で行う。";
        const target = element(true, text);

        const first = applyHighlight([{ element: target, text, startOffset: 0, endOffset: 2, wholeItem: false }]);
        expect(target.marked()).toBe("返金");
        expect(target.rendered()).toBe(text);

        clearHighlight(first);
        expect(target.rendered()).toBe(text);
        expect(target.marked()).toBe("");

        const second = applyHighlight([{ element: target, text, startOffset: 9, endOffset: 11, wholeItem: false }]);
        expect(target.marked()).toBe("返金");
        // Same characters, different place: the preceding text proves it is the second occurrence.
        expect(target.rendered().indexOf("返金申請")).toBe(9);
        clearHighlight(second);
        expect(target.rendered()).toBe(text);
    });

    it("does not use the class PDF.js already styles for its own find controller", () => {
        expect(HIGHLIGHT_CLASS).not.toBe("highlight");
    });
});
