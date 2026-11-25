import { describe, expect, test } from "bun:test";

const { bundleProjectSettings, buildBundleScenes, checkBundleAssetKeys } = await import("./importer");
const { buildAgentElement } = await import("./elements");
const { TICKS_PER_SECOND } = await import("@/wasm");

describe("bundle project settings", () => {
	test("canvas size and frame rate from the bundle", () => {
		expect(bundleProjectSettings({ width: 1440, height: 1920, fps: 60 })).toEqual({
			canvasSize: { width: 1440, height: 1920 },
			canvasSizeMode: "custom",
			fps: { numerator: 60, denominator: 1 },
		});
	});
	test("frame rate is optional", () => {
		expect(bundleProjectSettings({ width: 1080, height: 1920 })).toEqual({ canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "custom" });
	});
	test("invalid values are ignored", () => {
		expect(bundleProjectSettings({ width: 0, height: 1920 })).toBeNull();
		expect(bundleProjectSettings({ width: 1080.5, height: 1920 })).toBeNull();
		expect(bundleProjectSettings({ width: 1080, height: 1920, fps: -5 })).toEqual({ canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "custom" });
		expect(bundleProjectSettings({ width: 1080, height: 1920, fps: 0.0000001 })).toEqual({ canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "custom" });
		expect(bundleProjectSettings({ width: 1080, height: 1920, fps: 59.94 })?.fps).toEqual({ numerator: 60000, denominator: 1001 });
	});
});

describe("bundle asset keys", () => {
	test("repeated asset key is refused", () => {
		expect(() => checkBundleAssetKeys({
			assets: [
				{ key: "a", path: "one.png", type: "image", name: "One" },
				{ key: "a", path: "two.png", type: "image", name: "Two" },
			],
		})).toThrow("Duplicate asset key: a");
	});
});

describe("media trimStart", () => {
	const media = { id: "m", type: "video" as const, width: 1920, height: 1080, duration: 10 };
	const base = { e: { name: "clip", start: 0, duration: 2, asset: "a" }, media, trackId: "t", canvas: { width: 1920, height: 1080 }, keyframes: [] as never[] };

	test("negative trimStart is refused", () => {
		expect(() => buildAgentElement({ ...base, e: { ...base.e, trimStart: -3 } })).toThrow("trimStart must be 0 or more for clip");
	});

	test("a duration of zero or less is refused, also for compound clips", () => {
		for (const duration of [-1, 0, 0.5 / TICKS_PER_SECOND]) {
			expect(() => buildAgentElement({ ...base, e: { ...base.e, duration } })).toThrow("duration must be above 0 (clip)");
			expect(() => buildBundleScenes({
				bundle: { name: "t", width: 1920, height: 1080, assets: [], audio: [], overlay: [], main: [{ name: "group", start: 0, duration, compound: { main: [base.e] } }] },
				media: new Map([["a", media]]),
				sceneId: "main",
			})).toThrow("duration must be above 0 (group)");
		}
	});

	test("zero and fractional trimStart are accepted", () => {
		expect(() => buildAgentElement({ ...base, e: { ...base.e, trimStart: 0 } })).not.toThrow();
		const built = buildBundleScenes({
			bundle: { name: "t", width: 1920, height: 1080, assets: [], audio: [], overlay: [], main: [{ name: "clip", start: 0, duration: 2, asset: "a", trimStart: 2.5 }] },
			media: new Map([["a", media]]),
			sceneId: "main",
		});
		expect(built.tracks.main.elements[0].trimStart).toBeGreaterThan(0);
	});
});