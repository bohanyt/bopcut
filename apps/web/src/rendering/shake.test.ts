import { describe, expect, test } from "bun:test";
import type { ElementAnimations } from "@/animation/types";
import { getElementKeyframes, upsertPathKeyframe } from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { TimelineElement } from "@/timeline";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { applyShake, peakShakeIntensity, readShakeSettings, shakeOffset } from "./shake";

const base = { position: { x: 10, y: -20 }, scaleX: 1.2, scaleY: 1.2, rotate: 5 };
const TPS = 1000;

describe("camera shake", () => {
	test("no shake leaves the transform as it is", () => {
		const settings = readShakeSettings({});
		expect(applyShake({ transform: base, settings, animations: undefined, localTime: 500, ticksPerSecond: TPS })).toEqual(base);
	});

	test("offset is deterministic, bounded by the intensity and keeps scale", () => {
		const settings = readShakeSettings({ "shake.intensity": 20, "shake.frequency": 6, "shake.rotation": 2, "shake.seed": 7 });
		let maxX = 0;
		let maxR = 0;
		for (let t = 0; t < 3; t += 0.01) {
			const o = shakeOffset(settings!, t);
			maxX = Math.max(maxX, Math.abs(o.x), Math.abs(o.y));
			maxR = Math.max(maxR, Math.abs(o.rotate));
			expect(shakeOffset(settings!, t)).toEqual(o);
		}
		expect(maxX).toBeLessThanOrEqual(20 + 1e-9);
		expect(maxX).toBeGreaterThan(12);
		expect(maxR).toBeLessThanOrEqual(2 + 1e-9);
		const shaken = applyShake({ transform: base, settings, animations: undefined, localTime: 1234, ticksPerSecond: TPS });
		expect(shaken.scaleX).toBe(1.2);
		expect(shaken.position.x).not.toBe(10);
	});

	test("different seeds shake differently", () => {
		const a = readShakeSettings({ "shake.intensity": 10, "shake.seed": 1 })!;
		const b = readShakeSettings({ "shake.intensity": 10, "shake.seed": 2 })!;
		expect(shakeOffset(a, 0.37)).not.toEqual(shakeOffset(b, 0.37));
	});

	test("keyframed intensity (a normal element param keyframe) decays a hit to nothing", () => {
		const settings = readShakeSettings({ "shake.intensity": 30, "shake.rotation": 3 })!;
		const element = { id: "v", type: "video", name: "clip", mediaId: "m", startTime: 0, duration: 2 * TICKS_PER_SECOND, trimStart: 0, trimEnd: 0, params: { "shake.intensity": 30 } } as unknown as TimelineElement;
		const target = resolveAnimationTarget({ element, path: "shake.intensity" });
		expect(target).not.toBeNull();
		let animations: ElementAnimations | undefined;
		for (const [seconds, value] of [[0, 30], [0.4, 0]] as const) {
			animations = upsertPathKeyframe({
				animations,
				propertyPath: "shake.intensity",
				time: Math.round(seconds * TICKS_PER_SECOND) as MediaTime,
				value,
				channelLayout: target!.channelLayout,
				coerceValue: target!.coerceValue,
			});
		}
		const late = applyShake({ transform: base, settings, animations, localTime: 0.6 * TICKS_PER_SECOND, ticksPerSecond: TICKS_PER_SECOND });
		expect(late).toEqual(base);
		const early = applyShake({ transform: base, settings, animations, localTime: 0.037 * TICKS_PER_SECOND, ticksPerSecond: TICKS_PER_SECOND });
		expect(early.position.x !== 10 || early.position.y !== -20).toBe(true);
	});

	test("rotation is scaled against the peak keyframe, never above the set maximum", () => {
		// The base intensity is 0 and the keyframes rise to 40: rotation must still decay with them.
		const settings = readShakeSettings({ "shake.intensity": 0, "shake.rotation": 4 })!;
		const element = { id: "v", type: "video", name: "clip", mediaId: "m", startTime: 0, duration: 2 * TICKS_PER_SECOND, trimStart: 0, trimEnd: 0, params: {} } as unknown as TimelineElement;
		const target = resolveAnimationTarget({ element, path: "shake.intensity" })!;
		let animations: ElementAnimations | undefined;
		for (const [seconds, value] of [[0, 40], [1, 10]] as const) {
			animations = upsertPathKeyframe({
				animations,
				propertyPath: "shake.intensity",
				time: Math.round(seconds * TICKS_PER_SECOND) as MediaTime,
				value,
				channelLayout: target.channelLayout,
				coerceValue: target.coerceValue,
			});
		}
		expect(peakShakeIntensity(settings, animations)).toBe(40);
		// The timeline lists them like any other keyframe (markers, snapping).
		expect(getElementKeyframes({ animations }).filter((k) => k.propertyPath === "shake.intensity")).toHaveLength(2);
		let maxAtPeak = 0;
		let maxLate = 0;
		for (let t = 0; t < 3; t += 0.005) {
			maxAtPeak = Math.max(maxAtPeak, Math.abs(shakeOffset(settings, t, 40, 40).rotate));
			maxLate = Math.max(maxLate, Math.abs(shakeOffset(settings, t, 10, 40).rotate));
		}
		expect(maxAtPeak).toBeLessThanOrEqual(4 + 1e-9);
		expect(maxAtPeak).toBeGreaterThan(3);
		expect(maxLate).toBeLessThanOrEqual(1 + 1e-9);
		// A keyframe above the base value never pushes rotation past the maximum.
		expect(Math.abs(shakeOffset(readShakeSettings({ "shake.intensity": 5, "shake.rotation": 2 })!, 0.3, 50).rotate)).toBeLessThanOrEqual(2 + 1e-9);
	});

	test("settings are clamped", () => {
		expect(readShakeSettings({ "shake.intensity": -5, "shake.frequency": 999, "shake.rotation": -1 })).toEqual({ intensity: 0, frequency: 60, rotation: 0, seed: 1 });
	});
});
