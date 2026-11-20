import { describe, expect, test } from "bun:test";
import { applyAnimationPresets, PRESET_BLUR_EFFECT_ID, readAnimationPresets, reanchorOutPreset } from "./presets";
import { resolveAnimationPathValueAtTime } from "./resolve";
import { getChannelsFromData } from "./channel-data";
import { cloneAnimations, splitAnimationsAtTime, updateScalarKeyframeCurve, upsertPathKeyframe } from "./keyframes";
import { applyElementUpdate } from "@/timeline/update-pipeline";
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

	const own = (element: TextElement, path: string, seconds: number, value: number, id = `mine-${seconds}`) => {
		const target = resolveAnimationTarget({ element, path })!;
		return { ...element, animations: upsertPathKeyframe({ animations: element.animations, propertyPath: path, time: T(seconds), value, keyframeId: id, channelLayout: target.channelLayout, coerceValue: target.coerceValue }) };
	};

	test("a keyframe of the clip's own inside a preset's window is never written over: the preset is refused", () => {
		for (const t of [0, 0.1, 0.3]) {
			expect(() => applyAnimationPresets(own(text(2), "opacity", t, 0.7), { in: { type: "fade" } }, canvas)).toThrow(`has its own keyframe at ${t} s, inside the preset`);
		}
		// Just after the window: kept, and the fade ends at its value.
		const after = applyAnimationPresets(own(text(2), "opacity", 0.5, 0.7), { in: { type: "fade" } }, canvas);
		expect(at(after, "opacity", 0.3)).toBeCloseTo(0.7, 6);
		const removed = applyAnimationPresets(after, { in: { type: "none" } }, canvas);
		expect(keyIds(removed, "opacity")).toEqual(["mine-0.5"]);
		// Another property is no obstacle.
		expect(readAnimationPresets(applyAnimationPresets(own(text(2), "transform.rotate", 0, 10), { in: { type: "fade" } }, canvas)).in?.type).toBe("fade");
	});

	test("both sides at once are cleared before either is written (no opacity left at 0)", () => {
		const longOut = applyAnimationPresets(text(2), { out: { type: "fade", duration: 1.5 } }, canvas);
		const both = applyAnimationPresets(longOut, { in: { type: "fade", duration: 0.5 }, out: { type: "fade", duration: 0.3 } }, canvas);
		expect(at(both, "opacity", 0.5)).toBeCloseTo(1, 6);
		expect(at(both, "opacity", 1.2)).toBeCloseTo(1, 6);
		expect(readAnimationPresets(both)).toEqual({ in: { type: "fade", duration: 0.5 }, out: { type: "fade", duration: 0.3 } });
	});

	test("the clip's own motion outside a preset goes on as it was", () => {
		// A hold from 1 s to 1.5 s stays a hold, and the fade in ends at the value the clip has before it.
		let held = own(own(text(2), "opacity", 1, 0.8, "a"), "opacity", 1.5, 0.4, "b");
		held = { ...held, animations: updateScalarKeyframeCurve({ animations: held.animations, propertyPath: "opacity", componentKey: "value", keyframeId: "a", patch: { segmentToNext: "step" } }) };
		const faded = applyAnimationPresets(held, { in: { type: "fade", duration: 0.5 }, out: { type: "fade", duration: 0.3 } }, canvas);
		expect(at(faded, "opacity", 0.5)).toBeCloseTo(0.8, 6);
		expect(at(faded, "opacity", 0.8)).toBeCloseTo(0.8, 6);
		expect(at(faded, "opacity", 1.4)).toBeCloseTo(0.8, 6);
		expect(at(faded, "opacity", 1.6)).toBeCloseTo(0.4, 6);
		expect(at(faded, "opacity", 2)).toBe(0);
		// Pop's opacity joins at 40% of its window, its scale at the end: each measured where it joins.
		const pop = applyAnimationPresets(own(text(2), "transform.scaleX", 1, 3, "c"), { in: { type: "pop" } }, canvas);
		expect(at(pop, "transform.scaleX", 0.35)).toBeCloseTo(3, 6);
		expect(at(pop, "transform.scaleX", 0)).toBeCloseTo(1.5, 6);
	});

	test("a fade between equal values stays flat", () => {
		const hidden = applyAnimationPresets(text(2, { opacity: 0 }), { in: { type: "fade" } }, canvas);
		for (const s of [0.05, 0.1, 0.2, 0.3]) expect(at(hidden, "opacity", s)).toBe(0);
	});

	test("blur presets need a clip that takes effects; a side without room is refused, not dropped", () => {
		const compound = { ...text(), type: "compound", sceneId: "s" } as unknown as TextElement;
		expect(() => applyAnimationPresets(compound, { in: { type: "blur" } }, canvas)).toThrow("needs a clip that takes effects");
		const short = applyAnimationPresets(text(0.2), { in: { type: "fade" } }, canvas);
		expect(() => applyAnimationPresets(short, { out: { type: "fade" } }, canvas)).toThrow("no room for the out animation");
	});

	test("the out preset stays at the clip's end when its length changes, squeezed or dropped without room", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "fade" }, out: { type: "fade", duration: 0.5 } }, canvas);
		const longer = applyElementUpdate({ element: el, patch: { duration: T(3) }, context: { tracks: { main: { id: "m", elements: [] }, overlay: [], audio: [] } as never, trackId: "t" } }) as TextElement;
		expect(at(longer, "opacity", 2)).toBeCloseTo(1, 6);
		expect(at(longer, "opacity", 2.5)).toBeCloseTo(1, 6);
		expect(at(longer, "opacity", 3)).toBe(0);
		expect(readAnimationPresets(longer)).toEqual({ in: { type: "fade", duration: 0.3 }, out: { type: "fade", duration: 0.5 } });
		const squeezed = reanchorOutPreset({ ...el, duration: T(0.5) }, el.duration);
		expect(readAnimationPresets(squeezed).out?.duration).toBeCloseTo(0.2, 2);
		const gone = reanchorOutPreset({ ...el, duration: T(0.3) }, el.duration);
		expect(readAnimationPresets(gone).out).toBeNull();
	});

	test("copies and splits keep keyframes in their preset", () => {
		const el = applyAnimationPresets(text(2), { in: { type: "pop" }, out: { type: "fade", duration: 1 } }, canvas);
		const copy = { ...el, animations: cloneAnimations({ animations: el.animations, shouldRegenerateKeyframeIds: true }) };
		expect(keyIds(copy, "opacity")).not.toEqual(keyIds(el, "opacity"));
		expect(readAnimationPresets(copy)).toEqual(readAnimationPresets(el));
		// Split in the middle of the fade out: both new boundary keys belong to it.
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({ animations: el.animations, splitTime: T(1.5) });
		const left = { ...el, duration: T(1.5), animations: leftAnimations };
		const right = { ...el, duration: T(0.5), animations: rightAnimations };
		expect(keyIds(left, "opacity").filter((id) => !id.startsWith("anim-"))).toEqual([]);
		expect(keyIds(right, "opacity").every((id) => id.startsWith("anim-out-"))).toBe(true);
		expect(Object.values(applyAnimationPresets(right, { out: { type: "none" } }, canvas).animations ?? {}).filter(Boolean)).toEqual([]);
	});

	test("a shorter clip squeezes its out preset after the clip's own keys, never onto them", () => {
		const el = applyAnimationPresets(own(text(4), "opacity", 1.5, 0.7), { out: { type: "fade", duration: 1 } }, canvas);
		const times = (e: TextElement) => getChannelsFromData({ data: e.animations?.opacity as never })[0].keys.map((k) => k.time);
		// Trimmed to 2 s: the fade fits in the half second after the own key at 1.5 s.
		const trimmed = reanchorOutPreset({ ...el, duration: T(2) }, el.duration);
		expect(readAnimationPresets(trimmed).out?.duration).toBeCloseTo(0.5, 2);
		expect(at(trimmed, "opacity", 1.5)).toBeCloseTo(0.7, 6);
		expect(at(trimmed, "opacity", 2)).toBe(0);
		expect(new Set(times(trimmed)).size).toBe(times(trimmed).length);
		// The curve is squeezed with it: its handles shrink by the same factor.
		const handle = (e: TextElement) => (getChannelsFromData({ data: e.animations?.opacity as never })[0].keys.find((k) => k.id.startsWith("anim-out-")) as { rightHandle?: { dt: number } }).rightHandle?.dt ?? 0;
		expect(handle(trimmed)).toBeCloseTo(handle(el) / 2, -1);
		// Trimmed to the own key itself: no room, the preset goes (no two keys at one time).
		const onKey = reanchorOutPreset({ ...el, duration: T(1.5) }, el.duration);
		expect(readAnimationPresets(onKey).out).toBeNull();
		expect(new Set(times(onKey)).size).toBe(times(onKey).length);
	});
});

