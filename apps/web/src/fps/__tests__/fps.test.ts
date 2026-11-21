import { describe, expect, test } from "bun:test";
import { getCurrentFpsOption } from "@/fps/presets";
import {
	getHighestImportedVideoFps,
	getRaisedProjectFpsForImportedMedia,
	importedVideoProjectRate,
} from "@/fps/utils";

test("the settings picker distinguishes imported rates from integer presets", () => {
	expect(getCurrentFpsOption({ numerator: 30_000, denominator: 1_001 })).toEqual({ value: "30000/1001", label: "29.97 fps" });
	expect(getCurrentFpsOption({ numerator: 30, denominator: 1 })).toEqual({ value: "30", label: "30 fps" });
	expect(getCurrentFpsOption({ numerator: 32, denominator: 1 })).toEqual({ value: "32/1", label: "32 fps" });
});

test("invalid FPS metadata cannot install a project rate", () => {
	for (const fps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
		expect(importedVideoProjectRate(fps)).toBeNull();
	}
});

describe("getHighestImportedVideoFps", () => {
	test("returns the highest valid video fps", () => {
		expect(
			getHighestImportedVideoFps({
				mediaAssets: [
					{ type: "audio" },
					{ type: "video", fps: 30 },
					{ type: "image", fps: 120 },
					{ type: "video", fps: 60 },
				],
			}),
		).toBe(60);
	});

	test("ignores missing and invalid fps values", () => {
		expect(
			getHighestImportedVideoFps({
				mediaAssets: [
					{ type: "video" },
					{ type: "video", fps: 0 },
					{ type: "video", fps: -10 },
					{ type: "audio", fps: 120 },
				],
			}),
		).toBeNull();
	});
});

describe("getRaisedProjectFpsForImportedMedia", () => {
	test.each([[32, 32.1], [32.1, 32]])("chooses the highest normalized rate for %f and %f", (a, b) => {
		expect(getRaisedProjectFpsForImportedMedia({
			currentFps: { numerator: 30, denominator: 1 },
			importedAssets: [{ type: "video", fps: a }, { type: "video", fps: b }],
		})).toEqual({ numerator: 32, denominator: 1 });
	});

	test("does not raise the project for an incompatible VFR estimate close to 30 fps", () => {
		expect(getRaisedProjectFpsForImportedMedia({
			currentFps: { numerator: 30, denominator: 1 },
			importedAssets: [{ type: "video", fps: 30.6 }],
		})).toBeNull();
	});

	test("ignores a source which normalizes to the current rate", () => {
		expect(getRaisedProjectFpsForImportedMedia({
			currentFps: { numerator: 30_000, denominator: 1_001 },
			importedAssets: [{ type: "video", fps: 29.971 }],
		})).toBeNull();
	});

	test("raises the project fps to match a higher-fps import", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [{ type: "video", fps: 60 }],
			}),
		).toEqual({ numerator: 60, denominator: 1 });
	});

	test("does not lower the project fps for lower-fps imports", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 60, denominator: 1 },
				importedAssets: [{ type: "video", fps: 10 }],
			}),
		).toBeNull();
	});

	test("ignores non-video imports", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [
					{ type: "image", fps: 60 },
					{ type: "audio", fps: 120 },
				],
			}),
		).toBeNull();
	});
});
