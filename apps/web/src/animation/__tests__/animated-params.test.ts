import { describe, expect, test } from "bun:test";
import { getKeyframeById } from "@/animation/keyframe-query";
import { getScalarChannelValueAtTime } from "@/animation/interpolation";
import { retimeElementKeyframes, splitAnimationsAtTime } from "@/animation/keyframes";
import type { ScalarAnimationChannel } from "@/animation/types";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import {
	coerceParamValue,
	getParamDefaultInterpolation,
	getParamNumericRange,
	getParamValueKind,
} from "@/params";

describe("animated params", () => {
	test("looks up the stored value of a key moved to an occupied time", () => {
		const time = mediaTime({ ticks: 4000 });
		const animations = retimeElementKeyframes({
			propertyPath: "opacity",
			animations: {
				opacity: {
					keys: [
						{ id: "first", time: ZERO_MEDIA_TIME, value: 0.25, segmentToNext: "linear", tangentMode: "flat" },
						{ id: "second", time, value: 0.75, segmentToNext: "linear", tangentMode: "flat" },
					],
				},
			},
			timesByKeyframe: new Map([["first", time]]),
		});
		expect(getKeyframeById({ animations, propertyPath: "opacity", keyframeId: "first" })?.value).toBe(0.25);
		expect(getKeyframeById({ animations, propertyPath: "opacity", keyframeId: "second" })?.value).toBe(0.75);
	});

	test("splitting inside a Bezier segment keeps every key once", () => {
		const key = (id: string, time: number, value: number) =>
			({ id, time: mediaTime({ ticks: time }), value, segmentToNext: "bezier", tangentMode: "flat" }) as const;
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations: { opacity: { keys: [key("a", 0, 0), key("b", 4000, 1), key("c", 8000, 0), key("d", 8000, 1)] } },
			splitTime: mediaTime({ ticks: 6000 }),
			boundaryIdPrefix: "split",
		});
		const keys = (channel: unknown) => (channel as ScalarAnimationChannel).keys.map(({ id, time }): [string, number] => [id, time]);
		expect(keys(leftAnimations?.opacity).slice(0, 2)).toEqual([["a", 0], ["b", 4000]]);
		expect(keys(leftAnimations?.opacity)).toHaveLength(3);
		expect(keys(rightAnimations?.opacity).slice(1)).toEqual([["c", 2000], ["d", 2000]]);
	});

	test.each([2000, 10000])("splitting outside the keyed range keeps linear extrapolation at %i", (cut) => {
		const channel: ScalarAnimationChannel = {
			keys: [
				{ id: "a", time: mediaTime({ ticks: 4000 }), value: 0.25, segmentToNext: "linear", tangentMode: "flat" },
				{ id: "b", time: mediaTime({ ticks: 8000 }), value: 0.5, segmentToNext: "linear", tangentMode: "flat" },
			],
			extrapolation: { before: "linear", after: "linear" },
		};
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations: { opacity: channel },
			splitTime: mediaTime({ ticks: cut }),
			boundaryIdPrefix: "split",
		});
		const valueAt = (channel: ScalarAnimationChannel, time: number) =>
			getScalarChannelValueAtTime({ channel, time, fallbackValue: 0 });
		for (const time of [0, 500, 2000, 3000, 5000, 8000, 10000, 11000, 12000]) {
			const half = time < cut ? leftAnimations : rightAnimations;
			const localTime = time < cut ? time : time - cut;
			expect(valueAt(half?.opacity as ScalarAnimationChannel, localTime)).toBeCloseTo(valueAt(channel, time), 9);
		}
		const keyedHalf = cut === 2000 ? rightAnimations : leftAnimations;
		expect((keyedHalf?.opacity as ScalarAnimationChannel).keys.map(({ id }) => id)).toEqual(["a", "b"]);
	});

	test("a split past the last held key adds only one key to the empty half", () => {
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations: { opacity: { keys: [
				{ id: "a", time: ZERO_MEDIA_TIME, value: 0.25, segmentToNext: "linear", tangentMode: "flat" },
				{ id: "b", time: mediaTime({ ticks: 4000 }), value: 0.75, segmentToNext: "linear", tangentMode: "flat" },
			] } },
			splitTime: mediaTime({ ticks: 8000 }),
		});
		expect((leftAnimations?.opacity as ScalarAnimationChannel).keys.map(({ id }) => id)).toEqual(["a", "b"]);
		expect((rightAnimations?.opacity as ScalarAnimationChannel).keys.map(({ time, value }) => [time, value]))
			.toEqual([[0, 0.75]]);
	});

	test("snaps and clamps number params", () => {
		expect(
			coerceParamValue({
				param: {
					key: "intensity",
					labelKey: "params.intensity" as const,
					type: "number",
					default: 0,
					min: 0,
					max: 1,
					step: 0.25,
				},
				value: 0.62,
			}),
		).toBe(0.5);

		expect(
			coerceParamValue({
				param: {
					key: "intensity",
					labelKey: "params.intensity" as const,
					type: "number",
					default: 0,
					min: 0,
					max: 1,
					step: 0.25,
				},
				value: 1.2,
			}),
		).toBe(1);
	});

	test("rejects NaN and non-number values for number params", () => {
		const param = {
			key: "intensity",
			labelKey: "params.intensity" as const,
			type: "number" as const,
			default: 0,
			min: 0,
			max: 1,
			step: 0.25,
		};
		expect(coerceParamValue({ param, value: Number.NaN })).toBeNull();
		expect(coerceParamValue({ param, value: "0.5" })).toBeNull();
		expect(coerceParamValue({ param, value: true })).toBeNull();
	});

	test("passthrough with step <= 0 guard", () => {
		expect(
			coerceParamValue({
				param: {
					key: "x",
					labelKey: "params.x" as const,
					type: "number",
					default: 0,
					min: 0,
					step: 0,
				},
				value: 0.123,
			}),
		).toBe(0.123);
	});

	test("accepts valid select values", () => {
		const param = {
			key: "blend",
			labelKey: "params.blendMode" as const,
			type: "select" as const,
			default: "normal",
			options: [
				{ value: "normal", labelKey: "params.normal" as const },
				{ value: "multiply", labelKey: "params.multiply" as const },
			],
		};
		expect(coerceParamValue({ param, value: "normal" })).toBe("normal");
		expect(coerceParamValue({ param, value: "multiply" })).toBe("multiply");
	});

	test("rejects select values outside the allowed options", () => {
		expect(
			coerceParamValue({
				param: {
					key: "blend",
					labelKey: "params.blendMode" as const,
					type: "select",
					default: "normal",
					options: [
						{ value: "normal", labelKey: "params.normal" as const },
						{ value: "multiply", labelKey: "params.multiply" as const },
					],
				},
				value: "screen",
			}),
		).toBeNull();
	});

	test("rejects non-string select values", () => {
		const param = {
			key: "blend",
			labelKey: "params.blendMode" as const,
			type: "select" as const,
			default: "normal",
			options: [{ value: "normal", labelKey: "params.normal" as const }],
		};
		expect(coerceParamValue({ param, value: 42 })).toBeNull();
		expect(coerceParamValue({ param, value: null })).toBeNull();
		expect(coerceParamValue({ param, value: undefined })).toBeNull();
	});

	test("boolean params accept booleans and reject other types", () => {
		const param = {
			key: "visible",
			labelKey: "params.backgroundEnabled" as const,
			type: "boolean" as const,
			default: true,
		};
		expect(coerceParamValue({ param, value: true })).toBe(true);
		expect(coerceParamValue({ param, value: false })).toBe(false);
		expect(coerceParamValue({ param, value: 1 })).toBeNull();
		expect(coerceParamValue({ param, value: "true" })).toBeNull();
	});

	test("color params accept strings and reject other types", () => {
		const param = {
			key: "fill",
			labelKey: "params.fill" as const,
			type: "color" as const,
			default: "#ffffff",
		};
		expect(coerceParamValue({ param, value: "#ff0000" })).toBe("#ff0000");
		expect(coerceParamValue({ param, value: 0xff0000 })).toBeNull();
		expect(coerceParamValue({ param, value: null })).toBeNull();
	});

	test("getAnimationParamValueKind maps param type to binding kind", () => {
		expect(
			getParamValueKind({
				param: {
					key: "n",
					labelKey: "common.size" as const,
					type: "number",
					default: 0,
					min: 0,
					step: 1,
				},
			}),
		).toBe("number");
		expect(
			getParamValueKind({
				param: { key: "c", labelKey: "common.color" as const, type: "color", default: "#fff" },
			}),
		).toBe("color");
		expect(
			getParamValueKind({
				param: { key: "b", labelKey: "params.bold" as const, type: "boolean", default: false },
			}),
		).toBe("discrete");
		expect(
			getParamValueKind({
				param: {
					key: "s",
					labelKey: "common.select" as const,
					type: "select",
					default: "a",
					options: [{ value: "a", labelKey: "common.all" as const }],
				},
			}),
		).toBe("discrete");
	});

	test("getAnimationParamDefaultInterpolation is linear for continuous, hold for discrete", () => {
		expect(
			getParamDefaultInterpolation({
				param: {
					key: "n",
					labelKey: "common.size" as const,
					type: "number",
					default: 0,
					min: 0,
					step: 1,
				},
			}),
		).toBe("linear");
		expect(
			getParamDefaultInterpolation({
				param: { key: "c", labelKey: "common.color" as const, type: "color", default: "#fff" },
			}),
		).toBe("linear");
		expect(
			getParamDefaultInterpolation({
				param: { key: "b", labelKey: "params.bold" as const, type: "boolean", default: false },
			}),
		).toBe("hold");
		expect(
			getParamDefaultInterpolation({
				param: {
					key: "s",
					labelKey: "common.select" as const,
					type: "select",
					default: "a",
					options: [{ value: "a", labelKey: "common.all" as const }],
				},
			}),
		).toBe("hold");
	});

	test("getAnimationParamNumericRange returns spec for number params, undefined otherwise", () => {
		expect(
			getParamNumericRange({
				param: {
					key: "intensity",
					labelKey: "params.intensity" as const,
					type: "number",
					default: 0.5,
					min: 0,
					max: 1,
					step: 0.1,
				},
			}),
		).toEqual({ min: 0, max: 1, step: 0.1 });
		expect(
			getParamNumericRange({
				param: { key: "c", labelKey: "common.color" as const, type: "color", default: "#fff" },
			}),
		).toBeUndefined();
		expect(
			getParamNumericRange({
				param: { key: "b", labelKey: "params.bold" as const, type: "boolean", default: false },
			}),
		).toBeUndefined();
	});
});
