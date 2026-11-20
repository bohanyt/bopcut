import { describe, expect, test } from "bun:test";
import { applyAnimationPresets, presetLayerAt, readAnimationPresets, readPresetSettings } from "./presets";
import { buildTextElement } from "@/timeline/element-utils";
import { splitElementAt } from "@/timeline/split";
import type { TextElement, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const text = (seconds = 2, params: Record<string, unknown> = {}): TextElement =>
	({ ...buildTextElement({ raw: { duration: T(seconds), params: { content: "Hello world", ...params } as never }, startTime: T(0) }), id: "t" }) as TextElement;
const layer = (element: TimelineElement, seconds: number, canvasHeight = 1920) =>
	presetLayerAt(readPresetSettings(element.params), T(seconds), element.duration, canvasHeight);

describe("animation presets", () => {
	test("are clip settings: each side is set, replaced or removed on its own, keyframes untouched", () => {
		const base = { ...text(2), animations: { opacity: { keys: [] } } } as unknown as TextElement;
		const both = applyAnimationPresets(base, { in: { type: "pop" }, out: { type: "fade", duration: 0.5 } });
		expect(readAnimationPresets(both)).toEqual({ in: { type: "pop", duration: 0.35 }, out: { type: "fade", duration: 0.5 } });
		expect(both.animations).toBe(base.animations);
		const replaced = applyAnimationPresets(both, { in: { type: "fade" } });
		expect(readAnimationPresets(replaced)).toEqual({ in: { type: "fade", duration: 0.3 }, out: { type: "fade", duration: 0.5 } });
		const removed = applyAnimationPresets(replaced, { out: { type: "none" } });
		expect(readAnimationPresets(removed)).toEqual({ in: { type: "fade", duration: 0.3 }, out: null });
		expect(Object.keys(removed.params).filter((key) => key.startsWith("animation.out"))).toEqual([]);
	});

	test("bad requests are refused", () => {
		expect(() => applyAnimationPresets(text(), { in: { type: "spin" as never } })).toThrow("in animation must be one of");
		expect(() => applyAnimationPresets(text(), { out: { type: "fade", duration: 0 } })).toThrow("0.05 to 10 seconds");
		expect(() => applyAnimationPresets(text(), { out: { type: "fade", duration: 0.000001 } })).toThrow("0.05 to 10 seconds");
		const video = { ...text(), type: "video" } as unknown as TextElement;
		expect(() => applyAnimationPresets(video, { in: { type: "typewriter" } })).toThrow("typewriter is for text");
		const compound = { ...text(), type: "compound" } as unknown as TextElement;
		expect(() => applyAnimationPresets(compound, { out: { type: "dissolve" } })).toThrow("needs a clip that takes effects");
		// Unknown settings read as none.
		expect(readAnimationPresets(text(2, { "animation.in": "spin" }))).toEqual({ in: null, out: null });
	});

	test("fade in and out: from and to nothing, eased", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "fade" }, out: { type: "fade", duration: 0.5 } });
		expect(layer(el, 0).opacity).toBe(0);
		expect(layer(el, 0.15).opacity).toBeGreaterThan(0.5); // eased out: most of the way at half time
		expect(layer(el, 0.3).opacity).toBe(1);
		expect(layer(el, 1).opacity).toBe(1);
		expect(layer(el, 1.5).opacity).toBe(1);
		expect(layer(el, 1.75).opacity).toBeGreaterThan(0.5); // eased in: slow at first
		expect(layer(el, 1.999).opacity).toBeLessThan(0.01);
	});

	test("pop grows past full size and settles; impact comes down from large; fall drops and tips; dissolve and blur blur", () => {
		const pop = applyAnimationPresets(text(2), { in: { type: "pop" } });
		expect(layer(pop, 0).scale).toBeCloseTo(0.5, 6);
		expect(layer(pop, 0.35 * 0.65).scale).toBeCloseTo(1.1, 6);
		expect(layer(pop, 0.35).scale).toBe(1);
		const impact = applyAnimationPresets(text(2), { in: { type: "impact" } });
		expect(layer(impact, 0).scale).toBeCloseTo(1.6, 6);
		expect(layer(impact, 0.25).scale).toBe(1);
		const fall = applyAnimationPresets(text(2), { out: { type: "fall" } });
		expect(layer(fall, 1.5).offsetY).toBe(0);
		expect(layer(fall, 1.9999, 1920).offsetY).toBeCloseTo(480, 0);
		expect(layer(fall, 1.9999).rotate).toBeCloseTo(8, 1);
		const blurry = applyAnimationPresets(text(2), { in: { type: "blur" }, out: { type: "dissolve" } });
		expect(layer(blurry, 0).blur).toBe(30);
		expect(layer(blurry, 1).blur).toBe(0);
		expect(layer(blurry, 1.9999).blur).toBeCloseTo(30, 0);
	});

	test("typewriter types the letters in over its length", () => {
		const el = applyAnimationPresets(text(3), { in: { type: "typewriter", duration: 2 } });
		expect(layer(el, 0).typed).toBe(0);
		expect(layer(el, 1).typed).toBeCloseTo(0.5, 6);
		expect(layer(el, 2).typed).toBe(1);
	});

	test("on a short clip both sides are shortened alike; a longer clip keeps the out preset at its end", () => {
		const short = applyAnimationPresets(text(0.4), { in: { type: "fade", duration: 0.3 }, out: { type: "fade", duration: 0.3 } });
		expect(layer(short, 0.1).opacity).toBeLessThan(1); // the in side runs to 0.2 s
		expect(layer(short, 0.2).opacity).toBe(1);
		expect(layer(short, 0.3).opacity).toBeLessThan(1);
		const el = applyAnimationPresets(text(2), { out: { type: "fade", duration: 0.5 } });
		const longer = { ...el, duration: T(5) };
		expect(layer(longer, 2).opacity).toBe(1);
		expect(layer(longer, 4.75).opacity).toBeLessThan(1);
	});

	test("a split keeps the in preset on the left part and the out preset on the right, like audio fades", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "pop" }, out: { type: "fall" } });
		const parts = splitElementAt({ element: el, splitTime: T(1), rightId: "r" })!;
		expect(readAnimationPresets(parts.left)).toEqual({ in: { type: "pop", duration: 0.35 }, out: null });
		expect(readAnimationPresets(parts.right)).toEqual({ in: null, out: { type: "fall", duration: 0.5 } });
	});
});
