import { describe, expect, test } from "bun:test";
import { applyAnimationPresets, PRESET_BLUR_EFFECT_ID, readAnimationPresets } from "./presets";
import { resolveAnimationPathValueAtTime } from "./resolve";
import { getChannelsFromData } from "./channel-data";
import { upsertPathKeyframe } from "./keyframes";
import { buildTextElement } from "@/timeline/element-utils";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { buildEffectParamPath } from "./effect-param-channel";
import type { TextElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const text = (seconds = 2, params: Record<string, unknown> = {}): TextElement =>
	({ ...buildTextElement({ raw: { duration: T(seconds), params: { content: "Hello world", ...params } as never }, startTime: T(0) }), id: "t" }) as TextElement;
const at = (element: TextElement, path: string, seconds: number, fallback = 1) =>
	resolveAnimationPathValueAtTime({ animations: element.animations, propertyPath: path, localTime: T(seconds), fallbackValue: fallback }) as number;
const keyIds = (element: TextElement, path: string) => getChannelsFromData({ data: element.animations?.[path] as never }).flatMap((c) => c.keys.map((k) => k.id));
const canvas = { canvasHeight: 1920 };
const BLUR = buildEffectParamPath({ effectId: PRESET_BLUR_EFFECT_ID, paramKey: "intensity" });

describe("animation presets", () => {
	test("fade in and out: from and to nothing, the clip's own opacity in between", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "fade" }, out: { type: "fade", duration: 0.5 } }, canvas);
		expect(at(el, "opacity", 0)).toBe(0);
		expect(at(el, "opacity", 0.15)).toBeGreaterThan(0.5); // eased out: most of the way at half time
		expect(at(el, "opacity", 0.3)).toBeCloseTo(1, 6);
		expect(at(el, "opacity", 1)).toBeCloseTo(1, 6);
		expect(at(el, "opacity", 1.5)).toBeCloseTo(1, 6);
		expect(at(el, "opacity", 1.75)).toBeLessThan(1);
		expect(at(el, "opacity", 2)).toBe(0);
		expect(readAnimationPresets(el)).toEqual({ in: { type: "fade", duration: 0.3 }, out: { type: "fade", duration: 0.5 } });
	});

	test("pop grows past the clip's own scale and settles; impact comes down from large", () => {
		const base = text(2, { "transform.scaleX": 2, "transform.scaleY": 2 });
		const pop = applyAnimationPresets(base, { in: { type: "pop" } }, canvas);
		expect(at(pop, "transform.scaleX", 0)).toBeCloseTo(1, 6);
		expect(at(pop, "transform.scaleX", 0.35 * 0.65)).toBeCloseTo(2.2, 6);
		expect(at(pop, "transform.scaleY", 0.35)).toBeCloseTo(2, 6);
		expect(readAnimationPresets(pop).in?.type).toBe("pop");
		const impact = applyAnimationPresets(base, { in: { type: "impact" } }, canvas);
		expect(at(impact, "transform.scaleX", 0)).toBeCloseTo(3.2, 6);
		expect(at(impact, "transform.scaleX", 0.25)).toBeCloseTo(2, 6);
		expect(readAnimationPresets(impact).in?.type).toBe("impact");
	});

	test("blur in and dissolve out animate one blur effect, removed with them", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "blur" }, out: { type: "dissolve" } }, canvas);
		expect(el.effects?.filter((e) => e.id === PRESET_BLUR_EFFECT_ID).length).toBe(1);
		expect(at(el, BLUR, 0, 0)).toBe(30);
		expect(at(el, BLUR, 1, 0)).toBe(0);
		expect(at(el, BLUR, 2, 0)).toBe(30);
		expect(readAnimationPresets(el)).toMatchObject({ in: { type: "blur" }, out: { type: "dissolve" } });
		const onlyOut = applyAnimationPresets(el, { in: { type: "none" } }, canvas);
		expect(onlyOut.effects?.some((e) => e.id === PRESET_BLUR_EFFECT_ID)).toBe(true);
		const none = applyAnimationPresets(onlyOut, { out: { type: "none" } }, canvas);
		expect(none.effects?.some((e) => e.id === PRESET_BLUR_EFFECT_ID)).toBe(false);
		expect(Object.values(none.animations ?? {}).filter(Boolean)).toEqual([]);
	});

	test("fall drops a quarter of the canvas and tips over", () => {
		const el = applyAnimationPresets(text(2, { "transform.positionY": 100 }), { out: { type: "fall" } }, canvas);
		expect(at(el, "transform.positionY", 1.5, 0)).toBeCloseTo(100, 6);
		expect(at(el, "transform.positionY", 2, 0)).toBeCloseTo(100 + 480, 6);
		expect(at(el, "transform.rotate", 2, 0)).toBeCloseTo(8, 6);
		expect(readAnimationPresets(el).out?.type).toBe("fall");
	});

	test("typewriter types the text in; it is only for text", () => {
		const el = applyAnimationPresets(text(3), { in: { type: "typewriter", duration: 2 } }, canvas);
		expect(at(el, "typewriter", 0)).toBe(0);
		expect(at(el, "typewriter", 1)).toBeCloseTo(0.5, 6);
		expect(at(el, "typewriter", 2)).toBe(1);
		const video = { ...text(), type: "video" } as unknown as TextElement;
		expect(() => applyAnimationPresets(video, { in: { type: "typewriter" } }, canvas)).toThrow("typewriter is for text");
	});

	test("a preset again replaces the earlier one; the user's own keyframes stay and set the values", () => {
		const base = text(4);
		const target = resolveAnimationTarget({ element: base, path: "opacity" })!;
		// The user's own: half opacity from 2 s.
		const own = { ...base, animations: upsertPathKeyframe({ animations: base.animations, propertyPath: "opacity", time: T(2), value: 0.5, keyframeId: "mine", channelLayout: target.channelLayout, coerceValue: target.coerceValue }) };
		const first = applyAnimationPresets(own, { in: { type: "fade", duration: 1 } }, canvas);
		const second = applyAnimationPresets(first, { in: { type: "fade", duration: 0.5 } }, canvas);
		expect(keyIds(second, "opacity").filter((id) => id.startsWith("anim-in-")).length).toBe(2);
		expect(keyIds(second, "opacity")).toContain("mine");
		expect(at(second, "opacity", 0.5)).toBeCloseTo(0.5, 6); // the user's value where the fade ends
		expect(at(second, "opacity", 2)).toBeCloseTo(0.5, 6);
		expect(readAnimationPresets(second).in).toEqual({ type: "fade", duration: 0.5 });
		// The out side was not asked about: nothing there.
		expect(readAnimationPresets(second).out).toBeNull();
	});

	test("both sides are shortened to fit a short clip, also with the other side's earlier preset", () => {
		const el = applyAnimationPresets(text(0.4), { in: { type: "fade", duration: 0.3 }, out: { type: "fade", duration: 0.3 } }, canvas);
		expect(readAnimationPresets(el)).toEqual({ in: { type: "fade", duration: 0.2 }, out: { type: "fade", duration: 0.2 } });
		const later = applyAnimationPresets(applyAnimationPresets(text(1), { in: { type: "fade", duration: 0.6 } }, canvas), { out: { type: "fade", duration: 0.6 } }, canvas);
		expect(readAnimationPresets(later)).toEqual({ in: { type: "fade", duration: 0.6 }, out: { type: "fade", duration: 0.4 } });
	});

	test("bad requests are refused", () => {
		expect(() => applyAnimationPresets(text(), { in: { type: "spin" as never } }, canvas)).toThrow("in animation must be one of");
		expect(() => applyAnimationPresets(text(), { out: { type: "fade", duration: 0 } }, canvas)).toThrow("0 to 10 seconds");
	});
});
