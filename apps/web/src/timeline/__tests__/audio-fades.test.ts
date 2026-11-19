import { describe, expect, test } from "bun:test";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { buildAudioGainAutomation, fadeGainAt, hasAnimatedVolume, resolveEffectiveAudioGain, type AudioCapableElement } from "../audio-state";

const clip = (params: Record<string, unknown>, seconds = 4): AudioCapableElement =>
	({
		id: "a",
		type: "audio",
		name: "sound",
		sourceType: "upload",
		mediaId: "m",
		startTime: 0 as MediaTime,
		duration: Math.round(seconds * TICKS_PER_SECOND) as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		sourceDuration: Math.round(seconds * TICKS_PER_SECOND) as MediaTime,
		params: { volume: 0, muted: false, ...params },
	}) as unknown as AudioCapableElement;

describe("audio fades", () => {
	test("no fades: flat gain and no automation", () => {
		const c = clip({});
		expect(hasAnimatedVolume({ element: c })).toBe(false);
		expect(fadeGainAt({ element: c, localTime: 0 })).toBe(1);
		expect(resolveEffectiveAudioGain({ element: c, localTime: 2 })).toBeCloseTo(1, 6);
	});

	test("fade in rises from silence, fade out falls to silence at the clip end", () => {
		const c = clip({ fadeIn: 1, fadeOut: 0.5 });
		expect(hasAnimatedVolume({ element: c })).toBe(true);
		expect(fadeGainAt({ element: c, localTime: 0 })).toBe(0);
		expect(fadeGainAt({ element: c, localTime: 0.5 })).toBeCloseTo(0.5, 6);
		expect(fadeGainAt({ element: c, localTime: 2 })).toBe(1);
		expect(fadeGainAt({ element: c, localTime: 3.75 })).toBeCloseTo(0.5, 6);
		expect(fadeGainAt({ element: c, localTime: 4 })).toBe(0);
	});

	test("fades combine with the clip volume in dB", () => {
		const c = clip({ volume: -6, fadeOut: 2 });
		expect(resolveEffectiveAudioGain({ element: c, localTime: 3 })).toBeCloseTo(10 ** (-6 / 20) * 0.5, 5);
	});

	test("automation used by playback and export follows the fades", () => {
		const c = clip({ fadeIn: 0.2, fadeOut: 0.2 }, 1);
		const points = buildAudioGainAutomation({ element: c, fromLocalTime: 0, toLocalTime: 1, stepSeconds: 0.1 });
		expect(points[0].gain).toBe(0);
		expect(points.find((p) => Math.abs(p.localTime - 0.5) < 1e-9)?.gain).toBeCloseTo(1, 6);
		expect(points.at(-1)?.gain).toBe(0);
	});

	test("invalid fade values are ignored", () => {
		const c = clip({ fadeIn: -1, fadeOut: "x" });
		expect(hasAnimatedVolume({ element: c })).toBe(false);
		expect(fadeGainAt({ element: c, localTime: 0 })).toBe(1);
	});
});
