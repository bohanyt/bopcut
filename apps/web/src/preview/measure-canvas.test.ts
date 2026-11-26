import { afterAll, beforeAll, expect, test } from "bun:test";
import { Canvas } from "@napi-rs/canvas";
import { getElementBounds } from "@/preview/element-bounds";
import { createSubtitleMeasurementContext } from "@/subtitles/build-subtitle-text-element";
import { text } from "@/timeline/__tests__/compound-fixtures";

// Every canvas made through either browser API is counted and its size recorded.
const made: { width: number; height: number }[] = [];
const originals = ["OffscreenCanvas", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
beforeAll(() => {
	class CountingCanvas extends Canvas {
		constructor(width: number, height: number) {
			super(width, height);
			made.push({ width, height });
		}
	}
	Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, writable: true, value: CountingCanvas });
	Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
		createElement: () => {
			const canvas = new Canvas(300, 150);
			const record = { width: 300, height: 150 };
			made.push(record);
			return new Proxy(canvas, {
				set: (target, key, value) => {
					if (key === "width" || key === "height") record[key] = value;
					return Reflect.set(target, key, value);
				},
				get: (target, key) => {
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	} });
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("text bounds reuse one measuring context across calls", () => {
	const title = text("title", 0, 5);
	const bounds = () => getElementBounds({ element: title, canvasSize: { width: 1920, height: 1080 }, localTime: 1 });
	expect(bounds()).not.toBeNull();
	const before = made.length;
	for (let tick = 0; tick < 30; tick++) bounds();
	expect(made.length).toBe(before);
});

test("subtitle import measures with a 1×1 canvas, not a 4096×4096 one", () => {
	expect(createSubtitleMeasurementContext()).not.toBeNull();
	expect(made.at(-1)).toEqual({ width: 1, height: 1 });
});
