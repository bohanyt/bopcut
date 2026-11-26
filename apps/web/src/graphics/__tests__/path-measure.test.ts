import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { pathGraphicDefinition } from "../definitions/strokes";

/** SVG elements that measure every subpath as 100 long and the path as 100 x 50. */
let created = 0;
let layouts = 0;
const fakeDocument = {
	createElementNS: () => {
		created++;
		return {
			style: {},
			setAttribute() {},
			appendChild() {},
			remove() {},
			getTotalLength: () => 100,
			getPointAtLength: () => ({ x: 100, y: 0 }),
			getBBox: () => ({ x: 0, y: 0, width: 100, height: 50 }),
		};
	},
	body: { appendChild: () => { layouts++; } },
};
const globals = { document: fakeDocument, Path2D };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
});
afterAll(() => {
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function draw(d: string, drawProgress: number) {
	const canvas = createCanvas(100, 100);
	const ctx = canvas.getContext("2d");
	pathGraphicDefinition.render({
		ctx: ctx as never,
		params: { d, drawProgress, viewBox: "", stroke: "#ffffff", strokeWidth: 8 },
		width: 100,
		height: 100,
	});
	return ctx;
}

test("animating how much of a path is drawn measures the path once and lays out the page once", () => {
	const d = "M 0 10 L 100 10 m 0 20 l -100 0";
	draw(d, 0);
	const measuredOnce = created;
	for (let frame = 1; frame <= 30; frame++) draw(d, frame / 30);
	expect(created).toBe(measuredOnce);
	expect(layouts).toBe(1);
	// The drawing still follows the progress: all of the first subpath at one half.
	expect(draw(d, 0.5).getImageData(90, 20, 1, 1).data[3]).toBeGreaterThan(0);
	expect(draw(d, 0).getImageData(90, 20, 1, 1).data[3]).toBe(0);
	// Another path is measured on its own.
	draw("M 0 0 L 50 50", 1);
	expect(layouts).toBe(2);
});
