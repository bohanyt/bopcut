import { expect, mock, test } from "bun:test";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { getElementBounds } from "@/preview/element-bounds";
import { hitTest } from "@/preview/hit-test";
import type { TextElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { editedText } = await import("@/preview/components/text-edit-overlay");

const installed = new Set(GlobalFonts.families.map((font) => font.family));
const FONT = ["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Helvetica"].find((family) => installed.has(family))
	?? GlobalFonts.families[0]?.family ?? "sans-serif";
const canvasSize = { width: 1920, height: 1080 };
const ctx = createCanvas(16, 16).getContext("2d") as unknown as CanvasRenderingContext2D;

const textElement = (content: string): TextElement => ({
	id: "title",
	name: "Title",
	type: "text",
	startTime: 0 as MediaTime,
	duration: (2 * TICKS_PER_SECOND) as MediaTime,
	trimStart: 0 as MediaTime,
	trimEnd: 0 as MediaTime,
	params: { content, fontFamily: FONT, fontSize: 15 },
});

const bounds = (content: string) =>
	getElementBounds({ element: textElement(content), canvasSize, localTime: 0, textContext: ctx });

test("a text with all its characters deleted can still be clicked in the preview", () => {
	for (const content of ["", "\n"]) {
		const empty = bounds(content);
		if (!empty) throw new Error("no bounds");
		const line = bounds("M");
		if (!line) throw new Error("no bounds");
		// At least about one line tall and as wide as it is tall, around the text's position.
		expect(empty.height).toBeGreaterThanOrEqual(line.height * 0.9);
		expect(empty.width).toBeGreaterThanOrEqual(empty.height * 0.99);
		const hit = hitTest({
			canvasX: empty.cx,
			canvasY: empty.cy,
			elementsWithBounds: [{ trackId: "t", elementId: "title", element: textElement(content), bounds: empty }],
		});
		expect(hit?.elementId).toBe("title");
	}
});

test("a text with characters keeps its own bounds", () => {
	const long = bounds("A long line of text");
	const short = bounds("A");
	if (!long || !short) throw new Error("no bounds");
	expect(long.width).toBeGreaterThan(short.width * 4);
});

test("deleting every character on the canvas leaves no text, not a line break", () => {
	expect(editedText("\n")).toBe("");
	expect(editedText("")).toBe("");
	expect(editedText("Two\nlines")).toBe("Two\nlines");
	expect(editedText("\n\n")).toBe("\n\n");
});
