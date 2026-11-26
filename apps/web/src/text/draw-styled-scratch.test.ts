import { afterAll, beforeAll, expect, test } from "bun:test";
import { Canvas, createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { drawStyledText } from "@/text/draw-styled";
import { measureTextElement } from "@/text/measure-element";
import type { TextElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

const installed = new Set(GlobalFonts.families.map((font) => font.family));
const FONT = ["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Helvetica"].find((family) => installed.has(family))
	?? GlobalFonts.families[0]?.family ?? "sans-serif";

let created = 0;
const previous = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
beforeAll(() => {
	class CountingCanvas extends Canvas {
		constructor(width: number, height: number) {
			super(width, height);
			created += 1;
		}
	}
	Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, writable: true, value: CountingCanvas });
});
afterAll(() => {
	if (previous) Object.defineProperty(globalThis, "OffscreenCanvas", previous);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

const seconds = (value: number) => Math.round(value * TICKS_PER_SECOND) as MediaTime;

function draw(content: string, fontSize: number) {
	const element: TextElement = {
		id: "title", name: "Title", type: "text",
		startTime: seconds(0), duration: seconds(5), trimStart: seconds(0), trimEnd: seconds(0),
		params: {
			content, fontFamily: FONT, fontSize,
			"shadow.color": "#000000", "shadow.opacity": 0.8, "shadow.blur": 6, "shadow.offsetX": 4, "shadow.offsetY": 4,
		},
	};
	const canvas = createCanvas(960, 540);
	const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	ctx.translate(480, 270);
	const layout = measureTextElement({ element, canvasHeight: 540, localTime: seconds(1), ctx });
	drawStyledText({ ctx, layout, textColor: "#ffffff", backgroundColor: "transparent" });
	return Buffer.from(ctx.getImageData(0, 0, 960, 540).data);
}

test("shadowed text reuses its two scratch surfaces and draws the same pixels on a larger reused one", () => {
	const first = draw("Siapa yang menang?", 12);
	const afterFirst = created;
	expect(afterFirst).toBe(2);
	expect(draw("Siapa yang menang?", 12).equals(first)).toBe(true);
	expect(created).toBe(afterFirst);
	// A larger caption grows the scratch surfaces; the small one drawn on them stays identical.
	draw("Siapa yang menang ronde ini? Jawab di komentar!", 24);
	expect(draw("Siapa yang menang?", 12).equals(first)).toBe(true);
	expect(first.some((value) => value !== 0)).toBe(true);
});
