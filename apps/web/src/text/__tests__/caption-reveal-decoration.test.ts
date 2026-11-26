import { afterAll, beforeAll, expect, test } from "bun:test";
import { Canvas, createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { measureTextElement } from "@/text/measure-element";
import { drawStyledText } from "@/text/draw-styled";
import { makeCaption } from "@/text/caption";
import type { TextElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

const installed = new Set(GlobalFonts.families.map((font) => font.family));
const FONT =
	["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Helvetica"].find((family) =>
		installed.has(family),
	) ?? GlobalFonts.families[0]?.family ?? "sans-serif";

const previous = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
beforeAll(() =>
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: Canvas,
	}),
);
afterAll(() => {
	if (previous) Object.defineProperty(globalThis, "OffscreenCanvas", previous);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

const time = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;

const base: TextElement = {
	id: "caption",
	name: "Caption",
	type: "text",
	startTime: time(0),
	duration: time(2),
	trimStart: time(0),
	trimEnd: time(0),
	caption: makeCaption("Hello world", 2, [
		{ text: "Hello", start: 0, end: 1 },
		{ text: "world", start: 1, end: 2 },
	]),
	params: {
		content: "Hello world",
		fontFamily: FONT,
		fontSize: 15,
		textDecoration: "underline",
		"shadow.opacity": 0,
		"caption.reveal": true,
		"caption.revealFade": 0.2,
	},
};

function inked(localTimeSec: number) {
	const canvas = createCanvas(640, 360);
	const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	const layout = measureTextElement({
		element: base,
		canvasHeight: 360,
		localTime: time(localTimeSec),
		ctx,
	});
	ctx.translate(320, 180);
	drawStyledText({ ctx, layout, textColor: "#ffffff", backgroundColor: "transparent" });
	const pixels = ctx.getImageData(0, 0, 640, 360).data;
	let left = 640;
	let right = 0;
	for (let y = 0; y < 360; y++)
		for (let x = 0; x < 640; x++)
			if (pixels[(y * 640 + x) * 4 + 3] > 20) {
				left = Math.min(left, x);
				right = Math.max(right, x);
			}
	return { left, right, layout };
}

test("underline does not span hidden unrevealed caption words", () => {
	const early = inked(0.4);
	expect(early.layout.wordReveal).toEqual([1, 0]);
	const onlyFirst = inked(0.5);
	const both = inked(1.5);
	const firstWordOnlyWidth = onlyFirst.right - onlyFirst.left;
	expect(early.right - early.left).toBeLessThan(both.right - both.left - 30);
	expect(early.right - early.left).toBeLessThan(firstWordOnlyWidth + 15);
});