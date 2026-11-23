import { expect, mock, test } from "bun:test";
import { Canvas } from "@napi-rs/canvas";
import { computeAgentDraft, type DraftOp } from "@/agent/draft";
import type { EditorCore } from "@/core";
import { RendererManager } from "@/core/managers/renderer-manager";
import { registerDefaultEffects } from "@/effects";
import type { MediaAsset } from "@/media/types";
import { createPreviewFrameScheduler } from "@/preview/frame-scheduler";
import type { TScene, VideoElement } from "@/timeline";
import { scene, t, video } from "@/timeline/__tests__/compound-fixtures";
import { TICKS_PER_SECOND } from "@/wasm";
import { CanvasRenderer } from "./canvas-renderer";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import type { FrameDescriptor } from "./compositor/types";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { ColorNode } from "./nodes/color-node";
import { CompoundNode } from "./nodes/compound-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { RootNode } from "./nodes/root-node";
import { StickerNode } from "./nodes/sticker-node";
import { VideoNode } from "./nodes/video-node";
import { resolveRenderTree } from "./resolve";
import { buildScene } from "./scene-builder";

const size = { width: 960, height: 540 };
const fps = { numerator: 30, denominator: 1 };
const placement = {
	trimStart: 0, trimEnd: 0, opacity: 1,
	transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
};

function asset(id: string): MediaAsset {
	return { id, name: id, file: new File([], `${id}.mp4`), url: `blob:${id}`, type: "video" };
}

function clip(id: string, timeOffset: number, duration: number) {
	const { file, url } = asset(id);
	return new VideoNode({ ...placement, file, url: url!, mediaId: id, timeOffset, duration });
}

function patchProperties<T extends object>(target: T, values: Partial<T>) {
	const original = Object.getOwnPropertyDescriptors(target);
	const keys = Object.keys(values) as (keyof T)[];
	for (const key of keys) {
		Object.defineProperty(target, key, { configurable: true, value: values[key] });
	}
	return () => {
		for (const key of keys) {
			if (original[key]) Object.defineProperty(target, key, original[key]);
			else Reflect.deleteProperty(target, key);
		}
	};
}

function withRenderer(run: (fixture: ReturnType<typeof makeRenderer>) => Promise<void>) {
	const restore = patchProperties(globalThis, {
		document: { createElement: () => new Canvas(1, 1) } as unknown as Document,
	});
	return Promise.resolve().then(() => run(makeRenderer())).finally(restore);
}

function makeRenderer() {
	const renderer = new CanvasRenderer({ ...size, fps });
	const pixels = new Canvas(16, 9) as unknown as OffscreenCanvas;
	const decode = mock(async ({ time }: { time: number }) => ({
		canvas: pixels, timestamp: time, sourceWidth: pixels.width, sourceHeight: pixels.height,
	}));
	renderer.videoCache.getFrameAt = decode;
	async function render(node: RootNode, time: number) {
		await resolveRenderTree({ node, renderer, time });
		return buildFrameDescriptor({ node, renderer });
	}
	return { renderer, decode, render, pixels };
}

function observeResolved(node: VideoNode) {
	let state = node.resolved;
	const read = mock(() => state);
	const write = mock((value: VideoNode["resolved"]) => { state = value; });
	Object.defineProperty(node, "resolved", { get: read, set: write });
	return { read, write };
}

test("off-time children perform no resolver or descriptor work", () =>
	withRenderer(async ({ renderer, decode }) => {
		const visible = clip("current", 0, t(1));
		const offTime = [clip("past", -t(2), t(1)), clip("future", t(1), t(1))];
		const current = observeResolved(visible);
		const skipped = offTime.map(observeResolved);
		const node = new RootNode({ duration: t(2) })
			.add(new ColorNode({ color: "#112233" })).add(offTime[0]).add(visible).add(offTime[1]);

		await resolveRenderTree({ node, renderer, time: 0 });
		const writes = skipped.map(({ write }) => write.mock.calls.length);
		for (const { read } of skipped) read.mockClear();
		const { textures } = await buildFrameDescriptor({ node, renderer });

		expect({
			offTimeResolutions: writes,
			offTimeDescriptors: skipped.map(({ read }) => read.mock.calls.length),
		}).toEqual({ offTimeResolutions: [0, 0], offTimeDescriptors: [0, 0] });
		expect(decode).toHaveBeenCalledTimes(1);
		expect(current.write).toHaveBeenCalledTimes(1);
		expect(current.read).toHaveBeenCalled();
		expect(textures.map(({ id }) => id)).toEqual(["root:0:color", "root:2:source"]);
	}));

test("clip edges inside a frame keep half-open timing, stable order, and effect coverage", () =>
	withRenderer(async ({ render }) => {
		registerDefaultEffects();
		// Both cuts are inside the first 30 fps frame.
		const start = TICKS_PER_SECOND / 120;
		const end = 3 * start;
		const short = clip("short", start, end - start);
		const long = clip("long", 0, t(1));
		const effect = new EffectLayerNode({
			timeOffset: start, duration: end - start, effectType: "blur", effectParams: { intensity: 30 },
		});
		const root = new RootNode({ duration: t(1) }, [short, long, effect]);

		for (const [time, clipCount, effectCount] of [
			[start - 1, 1, 0], [start, 2, 1], [end - 1, 2, 1], [end, 1, 1], [end + 1, 1, 0], [start, 2, 1],
		]) {
			const { frame, textures } = await render(root, time);
			expect(textures.map(({ id }) => id)).toEqual(
				clipCount === 2 ? ["root:0:source", "root:1:source"] : ["root:1:source"],
			);
			expect(frame.items).toHaveLength(clipCount + effectCount);
		}
	}));

function timeline(elements: VideoElement[]) {
	return scene("main", {
		main: { id: "main", name: "Main", type: "video", hidden: false, muted: false, elements },
		overlay: [], audio: [],
	});
}

function makeTree(scenes: TScene[], mediaAssets: MediaAsset[]) {
	return buildScene({
		tracks: scenes[0].tracks, scenes, mediaAssets, canvasSize: size, duration: t(10),
		background: { type: "color", color: "transparent" }, isPreview: true,
	});
}

function applyDraft(scenes: TScene[], op: DraftOp) {
	const result = computeAgentDraft({
		scenes, ops: [op], rootSceneId: "main", mediaFor: () => undefined, canvas: size, fps, ripple: false,
	});
	expect(result.results[0]).toMatchObject({ ok: true });
	return result.scenes;
}

test("a crossfade still draws the outgoing source handle over the incoming clip", () =>
	withRenderer(async ({ decode, render }) => {
		const outgoing = { ...video("A", 0, 2), trimEnd: t(2), sourceDuration: t(4) };
		const incoming = video("B", 2, 2);
		const scenes = applyDraft([timeline([outgoing, incoming])], {
			op: "transition", type: "crossfade", duration: 0.5, match: { id: incoming.id },
		});
		const root = makeTree(scenes, [asset(outgoing.mediaId), asset(incoming.mediaId)]);
		expect((await render(root, t(2) - 1)).textures.map(({ id }) => id)).toEqual(["root:0:source"]);
		decode.mockClear();
		const { frame, textures } = await render(root, t(2.25));
		expect(textures).toMatchObject([
			{ id: "root:1:source", version: 0.25 },
			{ id: "root:2:source", version: 2.25 },
		]);
		expect(decode).toHaveBeenCalledTimes(2);
		expect(frame.items[1]).toMatchObject({ opacity: 0.5 });
		expect((await render(root, t(2.5))).textures.map(({ id }) => id)).toEqual(["root:1:source"]);
	}));

test("nested compounds render at each trimmed local time and release prior video state", () =>
	withRenderer(async ({ decode, render, pixels }) => {
		const visible = clip("nested", t(4), t(1));
		const innermost = new RootNode({ duration: t(20) }, [clip("later", t(12), t(1)), visible]);
		const inner = new CompoundNode({
			...placement, content: innermost, timeOffset: t(3), trimStart: t(4), duration: t(1),
		});
		const nested = new RootNode({ duration: t(10) }, [inner]);
		const outer = new CompoundNode({
			...placement, content: nested, timeOffset: t(1), trimStart: t(3), duration: t(1),
		});
		const root = new RootNode({ duration: t(10) }, [outer]);
		const composite = mock((_frame: FrameDescriptor) => pixels);
		const restore = patchProperties(wasmCompositor, {
			ensureInitialized() {}, syncTextures() {}, renderToTransparentCanvas: composite,
		});
		try {
			expect((await render(root, t(1) - 1)).textures).toEqual([]);
			expect((await render(root, t(1.25))).textures.map(({ id }) => id)).toEqual([
				"root:0:compound:0:compound:1:source",
				"root:0:compound:0:compound:source",
				"root:0:compound:source",
			]);
			expect(composite.mock.calls.map(([frame]) => frame.items.length)).toEqual([1, 1]);
			expect(decode.mock.calls).toMatchObject([[{ time: 0.25 }]]);
			expect(visible.resolved?.source).toBe(pixels);
			expect((await render(root, t(2))).textures).toEqual([]);
			expect(visible.resolved).toBeNull();
			expect(inner.resolved).toBeNull();
			expect((await render(root, t(1))).textures).toHaveLength(3);
		} finally {
			restore();
		}
	}));

test("installing a preview tree starts loading its off-time nested stickers", () =>
	withRenderer(async ({ render, renderer }) => {
		const requests: string[] = [];
		let finishLoad: (() => void) | undefined;
		class PreviewImage {
			naturalWidth = 200;
			naturalHeight = 200;
			width = this.naturalWidth;
			height = this.naturalHeight;
			onload?: () => void;
			set src(url: string) {
				requests.push(url);
				finishLoad = this.onload;
			}
		}
		const restore = patchProperties(globalThis, { Image: PreviewImage as unknown as typeof Image });
		try {
			const sticker = new StickerNode({
				...placement, stickerId: "flags:ID", timeOffset: t(1), duration: t(0.1),
			});
			const content = new RootNode({ duration: t(2) }).add(sticker);
			const compound = new CompoundNode({
				...placement, content, timeOffset: t(5), duration: t(2),
			});
			const root = new RootNode({ duration: t(7) }).add(compound);
			const preview = new RendererManager({} as EditorCore);
			preview.setRenderTree({ renderTree: root });
			expect(requests).toHaveLength(1);
			expect((await render(root, 0)).textures).toEqual([]);
			finishLoad?.();
			await resolveRenderTree({ node: root, renderer, time: t(6) });
			expect(sticker.resolved?.source).toBeInstanceOf(PreviewImage);
			expect(requests).toHaveLength(1);
		} finally {
			restore();
		}
	}));

test("draft timing edits are picked up by the next playback frame", () =>
	withRenderer(async ({ render }) => {
		const element = video("moving", 3, 1);
		const media = [asset(element.mediaId)];
		let scenes = [timeline([element])];
		let root = makeTree(scenes, media);
		let time: number = t(1);
		let frame: ReturnType<typeof render>;
		const scheduler = createPreviewFrameScheduler({
			render: () => {
				frame = render(root, time);
				return frame.then(() => {});
			},
			requestFrame: () => 0,
			cancelFrame: () => {},
		});
		async function playbackFrame() {
			scheduler.playbackTick();
			const result = await frame;
			time += TICKS_PER_SECOND / 30;
			return result.textures.map(({ id }) => id);
		}
		function move(start: number) {
			scenes = applyDraft(scenes, { op: "set", match: { id: element.id }, start });
			root = makeTree(scenes, media);
			scheduler.request();
		}
		try {
			expect(await playbackFrame()).toEqual([]);
			move(1);
			expect(await playbackFrame()).toEqual(["root:0:source"]);
			move(3);
			expect(await playbackFrame()).toEqual([]);
		} finally {
			scheduler.dispose();
		}
	}));
