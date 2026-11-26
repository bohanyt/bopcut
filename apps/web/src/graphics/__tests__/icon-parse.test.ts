import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { Window } from "happy-dom";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { iconGraphicDefinition } from "../definitions/icon";

const dom = new Window();
let parses = 0;
/** The browser's parser, counted. */
class CountingParser {
	parseFromString(text: string, type: string) {
		parses++;
		return new dom.DOMParser().parseFromString(text, type as never);
	}
}
/** The browser's matrix for the one transform these icons use; the canvas package does not read transform text. */
class TranslateMatrix {
	a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
	constructor(transform: string) {
		const match = /^translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/.exec(transform);
		if (!match) throw new Error(`Unsupported transform ${transform}`);
		[this.e, this.f] = [Number(match[1]), Number(match[2])];
	}
}
const globals = { DOMParser: CountingParser, DOMMatrix: TranslateMatrix, Path2D, OffscreenCanvas: class { constructor(width: number, height: number) { return createCanvas(width, height); } } };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
});
afterAll(async () => {
	await dom.close();
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

// A circle in the icon's color on the left, and a green square that a group moves to the right half.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="6" cy="12" r="5" fill="currentColor"/><g fill="#00ff00" transform="translate(12 0)"><rect x="1" y="7" width="10" height="10"/></g></svg>`;

function draw(params: { svg: string; color: string }, size: number) {
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext("2d");
	iconGraphicDefinition.render({ ctx: ctx as never, params, width: size, height: size });
	return (x: number, y: number) => {
		const [r, g, b, a] = ctx.getImageData(Math.floor(x * size), Math.floor(y * size), 1, 1).data;
		return a < 128 ? "clear" : `${r},${g},${b}`;
	};
}

test("an icon animating its size and color parses its SVG once and draws every frame right", () => {
	parses = 0;
	for (const [frame, size] of [24, 30, 36, 42, 48, 54].entries()) {
		const color = frame % 2 ? "#ff0000" : "#0000ff";
		const pixel = draw({ svg, color }, size);
		expect([pixel(0.25, 0.5), pixel(0.75, 0.5), pixel(0.5, 0.1)])
			.toEqual([frame % 2 ? "255,0,0" : "0,0,255", "0,255,0", "clear"]);
	}
	expect(parses).toBe(1);
	draw({ svg: svg.replace("#00ff00", "#ffffff"), color: "#ff0000" }, 24);
	expect(parses).toBe(2);
	// A broken icon draws nothing, and is not parsed again either.
	expect(draw({ svg: "<svg", color: "#ff0000" }, 24)(0.25, 0.5)).toBe("clear");
	draw({ svg: "<svg", color: "#ff0000" }, 30);
	expect(parses).toBe(3);
});

test("a graphic's source is kept while nothing changes, and redrawn for another SVG", () => {
	const node = new GraphicNode({
		timeOffset: 0, duration: 1, trimStart: 0, trimEnd: 0, opacity: 1,
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		definitionId: "icon", params: {},
	} as never);
	const first = node.getSource({ resolvedParams: { svg, color: "#ff0000" }, width: 48, height: 48 });
	expect(node.getSource({ resolvedParams: { svg, color: "#ff0000" }, width: 48, height: 48 })).toBe(first);
	const other = node.getSource({ resolvedParams: { svg: svg.replace("#00ff00", "#ffffff"), color: "#ff0000" }, width: 48, height: 48 });
	expect(other).not.toBe(first);
	expect(node.getSource({ resolvedParams: { svg, color: "#00ff00" }, width: 48, height: 48 })).not.toBe(other);
});
