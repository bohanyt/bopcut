import { describe, expect, test } from "bun:test";

const { bundleProjectSettings } = await import("./importer");

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
	});
});
