import { expect, spyOn, test } from "bun:test";
import { Path2D } from "@napi-rs/canvas";
import { buildDefaultMaskInstance, registerDefaultMasks } from "@/masks";
import { CanvasRenderer } from "./canvas-renderer";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import type { TextureCanvasDrawFn } from "./compositor/types";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ImageNode } from "./nodes/image-node";
import { RootNode } from "./nodes/root-node";
import * as graphics from "./renderer-device";
import { resolveRenderTree } from "./resolve";

const visual = {
	timeOffset: 0, duration: 1, trimStart: 0, trimEnd: 0, opacity: 1,
	transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
};
const fps = { numerator: 30, denominator: 1 };

async function withSurfaces(run: (fixture: {
	allocations: { width: number; height: number }[];
	context: Parameters<TextureCanvasDrawFn>[0];
}) => Promise<void>) {
	const allocations: { width: number; height: number }[] = [];
	class TestImage {
		naturalWidth = 12_000;
		naturalHeight = 1000;
		width = this.naturalWidth;
		height = this.naturalHeight;
		onload?: () => void;
		set src(_url: string) { this.onload?.(); }
	}
	const context = {
		drawImage() {}, scale() {}, save() {}, restore() {}, translate() {}, rotate() {},
		fill() {}, stroke() {},
	} as unknown as Parameters<TextureCanvasDrawFn>[0];
	class TestCanvas {
		constructor(public width: number, public height: number) {
			allocations.push({ width, height });
		}
		getContext() { return context; }
	}
	const globals = { Image: TestImage, OffscreenCanvas: TestCanvas, Path2D, document: { createElement: () => ({}) } };
	const descriptors = Object.getOwnPropertyDescriptors(globalThis);
	const limits = spyOn(graphics, "getRendererLimits")
		.mockReturnValue({ maxTextureDimension: 4096, maxSurfaceDimension: 4096 });
	try {
		for (const [name, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, name, { value, configurable: true });
		}
		await run({ allocations, context });
	} finally {
		limits.mockRestore();
		for (const name of Object.keys(globals)) {
			if (descriptors[name]) Object.defineProperty(globalThis, name, descriptors[name]);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
}

test("large saved canvases fit the preview but full-size capture reports the device limit", () =>
	withSurfaces(async () => {
		const dimensions = { width: 7680, height: 4320, fps };
		const renderer = new CanvasRenderer(dimensions);
		expect({ width: renderer.outputWidth, height: renderer.outputHeight }).toEqual({ width: 4096, height: 2304 });
		expect(() => new CanvasRenderer({ ...dimensions, requireFullSize: true })).toThrow("4096 pixels per side");
	}));

test("large foreground and blurred backdrop images share safe pixels and keep their aspect ratio", () =>
	withSurfaces(async ({ allocations }) => {
		const renderer = new CanvasRenderer({ width: 1920, height: 1080, fps, exactFrames: true });
		const source = { mediaId: "panorama", url: "blob:surface-limits-panorama" };
		const image = new ImageNode({ ...visual, ...source });
		const blur = new BlurBackgroundNode({
			...visual, ...source, file: new File([], "panorama.jpg"), mediaType: "image", blurIntensity: 20,
		});
		const node = new RootNode({ duration: 1 }).add(blur).add(image);
		await resolveRenderTree({ node, renderer, time: 0 });
		const { frame, textures } = await buildFrameDescriptor({ node, renderer });
		expect(allocations).toEqual([{ width: 4096, height: 341 }]);
		expect(blur.resolved?.backdropSource.source).toBe(image.resolved?.source);
		expect(textures[1]).toMatchObject({ width: 4096, height: 341 });
		expect(frame.items[1]).toMatchObject({ transform: { width: 1920, height: 160 } });
	}));

test("zoomed icons, masks and strokes fit their backing surfaces without shrinking the layer", () =>
	withSurfaces(async ({ allocations, context }) => {
		registerDefaultMasks();
		const mask = buildDefaultMaskInstance({ maskType: "rectangle" });
		mask.params.strokeWidth = 5;
		const icon = new GraphicNode({
			...visual,
			definitionId: "icon",
			params: {},
			masks: [mask],
			transform: { ...visual.transform, scaleX: -8, scaleY: 8, rotate: 45 },
		});
		const renderer = new CanvasRenderer({ width: 3840, height: 2160, fps });
		const node = new RootNode({ duration: 1 }).add(icon);
		await resolveRenderTree({ node, renderer, time: 0 });
		const { frame, textures } = await buildFrameDescriptor({ node, renderer });
		for (const texture of textures) {
			if (texture.kind === "rendered") texture.draw(context);
		}
		expect(frame.items[0]).toMatchObject({
			transform: { width: 17_280, height: 17_280, rotationDegrees: 45, flipX: true },
		});
		expect(allocations).toEqual([
			{ width: 3840, height: 3840 },
			{ width: 2160, height: 2160 },
			{ width: 2160, height: 2160 },
		]);
	}));
