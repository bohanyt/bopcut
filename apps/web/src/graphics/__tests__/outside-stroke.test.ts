import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { ellipseGraphicDefinition } from "../definitions/ellipse";
import { rectangleGraphicDefinition } from "../definitions/rectangle";
import type { GraphicDefinition } from "../types";

// The temporary stroke canvas falls back to document.createElement where there is no OffscreenCanvas.
const globals = { document: { createElement: () => createCanvas(1, 1) }, Path2D };
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

/** Draws a 100 x 100 shape with a 10 px red outside stroke at `scale` (a preview at ½ quality is 0.5). */
function draw(definition: GraphicDefinition, scale = 1) {
	const size = 100 * scale;
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	definition.render({
		ctx: ctx as never,
		params: { fill: "#ffffff", stroke: "#ff0000", strokeWidth: 10, strokeAlign: "outside", cornerRadius: 0 },
		width: 100,
		height: 100,
	});
	/** The color at a point of the 100 x 100 box. */
	return (x: number, y: number) => {
		const [r, g, b, a] = ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
		return a < 128 ? "clear" : r > 200 && g < 60 && b < 60 ? "red" : r > 200 && g > 200 && b > 200 ? "white" : `${r},${g},${b},${a}`;
	};
}

test("an outside stroke stays inside the graphic's box, around the fill", () => {
	for (const definition of [rectangleGraphicDefinition, ellipseGraphicDefinition]) {
		const at = draw(definition);
		expect([at(4, 50), at(96, 50), at(50, 4), at(50, 96)]).toEqual(["red", "red", "red", "red"]);
		expect([at(16, 50), at(50, 50)]).toEqual(["white", "white"]);
	}
	// A sharp-cornered rectangle shows its stroke on all four sides.
	const at = draw(rectangleGraphicDefinition);
	expect([at(2, 2), at(98, 98)]).toEqual(["red", "red"]);
});

test("an outside stroke is in the same place at half and quarter preview quality", () => {
	for (const scale of [0.5, 0.25]) {
		const at = draw(rectangleGraphicDefinition, scale);
		expect([at(4, 50), at(97, 50), at(50, 97)]).toEqual(["red", "red", "red"]);
		expect(at(50, 50)).toBe("white");
	}
});
