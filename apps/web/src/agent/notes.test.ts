import { describe, expect, test } from "bun:test";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import type { SceneTracks, VideoTrack, ImageElement } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { registerDefaultMasks } from "@/masks";
import { elementsInNoteBox, validNote } from "./notes";

describe("notes", () => {
	test("accepts valid points and ranges", () => {
		expect(validNote("catatan", 0, undefined)).toBe(true);
		expect(validNote("catatan", 1.25, 2.5)).toBe(true);
	});
	test("rejects empty text and invalid times", () => {
		for (const [text, start, end] of [[" ", 0, undefined], ["a", -1, undefined], ["a", 2, 1], ["a", NaN, undefined], ["a", 0, Infinity]]) expect(validNote(text, start, end)).toBe(false);
	});
});

const time = mediaTimeFromSeconds({ seconds: 0 });
const duration = mediaTimeFromSeconds({ seconds: 2 });
const image = (id: string, params: ImageElement["params"] = {}): ImageElement => ({
	id, name: id, type: "image", mediaId: id, params, startTime: time, duration, trimStart: time, trimEnd: time,
});
const track = (id: string, elements: ImageElement[], hidden = false, muted = false): VideoTrack => ({
	id, name: id, type: "video", elements, hidden, muted,
});

test("reports transformed hits topmost first, including muted tracks, and skips invisible elements", () => {
	registerDefaultMasks();
	const globals = { document: { createElement: () => createCanvas(96, 96) }, Path2D };
	const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
	try {
		const masked = image("masked");
		masked.masks = [{ id: "mask", type: "rectangle", params: {
			centerX: 0, centerY: 0, width: 0.1, height: 0.1, rotation: 0, scale: 1,
			feather: 0, inverted: false, strokeColor: "#fff", strokeWidth: 0, strokeAlign: "inside",
		} }];
		const tracks: SceneTracks = {
			overlay: [
				track("hidden", [image("hidden")], true),
				track("muted", [image("muted"), { ...image("hidden-element"), hidden: true }], false, true),
				track("top", [image("turned", { "transform.scaleX": 0.6, "transform.scaleY": 0.1, "transform.rotate": 90, "transform.positionX": 25 })]),
				track("mask", [masked, image("outside", { "transform.positionX": -100 })]),
				track("transparent", [image("invisible", { opacity: 0 }), image("fading-in", { "animation.in": "fade" })]),
			],
			main: track("main", [image("bottom")], false, true),
			audio: [],
		};
		expect(elementsInNoteBox({ x: 0.72, y: 0.34, width: 0.06, height: 0.06 }, time, tracks, { width: 100, height: 100 }, []))
			.toEqual([
				{ id: "muted", name: "muted", type: "image" },
				{ id: "turned", name: "turned", type: "image" },
				{ id: "bottom", name: "bottom", type: "image" },
			]);
		masked.masks[0].params.feather = 55;
		expect(elementsInNoteBox({ x: 0.72, y: 0.34, width: 0.06, height: 0.06 }, time, tracks, { width: 100, height: 100 }, []).map(({ id }) => id))
			.toEqual(["muted", "turned", "masked", "bottom"]);
	} finally {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
