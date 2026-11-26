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

function poppingLayout(revealPop: number, localTimeSec: number) {
	const element: TextElement = {
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
			"shadow.color": "#000000",
			"shadow.opacity": 0.8,
			"shadow.blur": 4,
			"shadow.offsetX": 0,
			"shadow.offsetY": 0,
			"caption.reveal": true,
			"caption.revealFade": 0.2,
			"caption.revealPop": revealPop,
			"caption.activeEnabled": false,
		},
	};
	const ctx = createCanvas(640, 360).getContext("2d") as unknown as CanvasRenderingContext2D;
	return measureTextElement({
		element,
		canvasHeight: 360,
		localTime: time(localTimeSec),
		ctx,
	});
}

test("the bounds of a caption include the pop of appearing words", () => {
	const at = 1.05;
	const pop1 = poppingLayout(1, at);
	const pop2 = poppingLayout(2, at);
	expect(pop2.style.revealPop).toBe(2);
	expect(pop2.wordReveal?.[1]).toBeGreaterThan(0);
	expect(pop2.wordReveal?.[1]).toBeLessThan(1);
	expect(pop2.visualRect.width).toBeGreaterThan(pop1.visualRect.width * 1.2);
});

function inkOf(revealPop: number, localTimeSec: number) {
	const element: TextElement = {
		id: "caption",
		name: "Caption",
		type: "text",
		startTime: time(0),
		duration: time(2),
		trimStart: time(0),
		trimEnd: time(0),
		caption: makeCaption("Pop", 2, [{ text: "Pop", start: 0, end: 1 }]),
		params: {
			content: "Pop",
			fontFamily: FONT,
			fontSize: 20,
			"shadow.color": "#000000",
			"shadow.opacity": 0.8,
			"shadow.blur": 2,
			"shadow.offsetX": 0,
			"shadow.offsetY": 0,
			"caption.reveal": true,
			"caption.revealFade": 0.4,
			"caption.revealPop": revealPop,
			"caption.activeEnabled": false,
		},
	};
	const ctx = createCanvas(640, 360).getContext("2d") as unknown as CanvasRenderingContext2D;
	const layout = measureTextElement({ element, canvasHeight: 360, localTime: time(localTimeSec), ctx });
	ctx.translate(320, 180);
	drawStyledText({ ctx, layout, textColor: "#ffffff", backgroundColor: "transparent" });
	const pixels = ctx.getImageData(0, 0, 640, 360).data;
	let minX = 640;
	let maxX = 0;
	for (let y = 0; y < 360; y++)
		for (let x = 0; x < 640; x++)
			if (pixels[(y * 640 + x) * 4 + 3] > 40) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
	return { width: maxX - minX, minX, maxX, rect: layout.visualRect };
}

test("a popping word with a shadow is drawn at its full size, inside its bounds", () => {
	// At 0.08 s of a 0.4 s reveal with pop 2.5 the word is drawn about 1.77× its size.
	const settled = inkOf(1, 1.5);
	const popping = inkOf(2.5, 0.08);
	expect(popping.width).toBeGreaterThan(settled.width * 1.6);
	expect(popping.minX).toBeGreaterThanOrEqual(Math.floor(320 + popping.rect.left) - 1);
	expect(popping.maxX).toBeLessThanOrEqual(Math.ceil(320 + popping.rect.left + popping.rect.width) + 1);
});
