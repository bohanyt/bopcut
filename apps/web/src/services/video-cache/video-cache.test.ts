import { expect, spyOn, test } from "bun:test";
import { Canvas } from "@napi-rs/canvas";
import { EncodedPacket, EncodedPacketSink, Input, InputVideoTrack, VideoSample, VideoSampleSink } from "mediabunny";
import { TICKS_PER_SECOND } from "@/wasm";
import { VideoCache } from "./service";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildFrameDescriptor } from "@/services/renderer/compositor/frame-descriptor";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import { CompoundNode } from "@/services/renderer/nodes/compound-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { hasSameVisibleVideoClips, resolveRenderTree } from "@/services/renderer/resolve";

const ticks = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);
const fps = { numerator: 30, denominator: 1 };

class TestCanvas {
	constructor(public width = 0, public height = 0) {}
	getContext() {
		return { canvas: this, clearRect() {} };
	}
}

type TestFrame = { timestamp: number; duration: number };

async function withVideo(
	frames: TestFrame[],
	run: (fixture: {
		file: File;
		starts: number[];
		decoded: number[];
		closed: number[];
		pixels: Map<OffscreenCanvas, TestFrame>;
	}) => Promise<void>,
	{ width = 3840, height = 2160, rotation = 0, seekError, draw }: {
		width?: number; height?: number; rotation?: number; seekError?: Error;
		draw?: (ctx: OffscreenCanvasRenderingContext2D, frame: TestFrame) => void;
	} = {},
) {
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	const globals = {
		document: { createElement: () => new TestCanvas() },
		OffscreenCanvas: draw ? Canvas : TestCanvas,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const track: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: width },
		displayHeight: { value: height },
		rotation: { value: rotation },
		canDecode: { value: async () => true },
	});
	const starts: number[] = [];
	const decoded: number[] = [];
	const closed: number[] = [];
	const pixels = new Map<OffscreenCanvas, TestFrame>();
	const trackSpy = spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(track);
	const sampleSpy = spyOn(VideoSampleSink.prototype, "samples").mockImplementation(
		async function* (start = 0) {
			starts.push(start);
			if (seekError) throw seekError;
			const after = frames.findIndex((frame) => frame.timestamp > start);
			const first = after < 0 ? frames.length - 1 : Math.max(0, after - 1);
			for (const frame of frames.slice(first)) {
				decoded.push(frame.timestamp);
				const sample: VideoSample = Object.create(VideoSample.prototype, {
					timestamp: { value: frame.timestamp },
					duration: { value: frame.duration },
					drawWithFit: {
						value: (ctx: OffscreenCanvasRenderingContext2D, options: { fit: string; rotation: number }) => {
							expect(options).toEqual({ fit: "fill", rotation });
							draw?.(ctx, frame);
							pixels.set(ctx.canvas, frame);
						},
					},
					close: { value: () => closed.push(frame.timestamp) },
				});
				yield sample;
			}
		},
	);
	try {
		await run({ file: new File([], "source.webm"), starts, decoded, closed, pixels });
	} finally {
		sampleSpy.mockRestore();
		trackSpy.mockRestore();
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

function clip(file: File, trimStart = 0, zoom = 1, mediaId = "source") {
	return new VideoNode({
		mediaId, file, url: "blob:source",
		trimStart: ticks(trimStart), trimEnd: 0, timeOffset: 0, duration: ticks(40),
		transform: { scaleX: zoom, scaleY: zoom, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
	});
}

test("scrub recovery can present a completed time within a video clip and rejects cuts inside compounds", () => {
	const first = clip(new File([], "first.mp4"));
	first.params.duration = ticks(2);
	const second = clip(new File([], "second.mp4"));
	second.params.timeOffset = ticks(2);
	const compound = new CompoundNode({
		content: new RootNode({ duration: ticks(40) }).add(first).add(second),
		timeOffset: ticks(3), duration: ticks(10), trimStart: ticks(1), trimEnd: 0,
		transform: first.params.transform, opacity: 1,
	});
	const root = new RootNode({ duration: ticks(15) }).add(compound);
	expect(hasSameVisibleVideoClips(root, ticks(3), ticks(3.5))).toBe(true);
	expect(hasSameVisibleVideoClips(root, ticks(3.5), ticks(4))).toBe(false);
	expect(hasSameVisibleVideoClips(root, ticks(2.9), ticks(3))).toBe(false);
});

async function resolveFrame(renderer: CanvasRenderer, node: RootNode, seconds: number) {
	try {
		await resolveRenderTree({ renderer, node, time: ticks(seconds) });
		return await buildFrameDescriptor({ renderer, node });
	} finally {
		renderer.videoCache.finishFrame();
	}
}

function rendererAt(renderScale = 0.25, exactFrames = false) {
	return new CanvasRenderer({ width: 3840, height: 2160, fps, renderScale, exactFrames });
}

const constantRate = (seconds: number) => Array.from({ length: seconds * 30 }, (_, i) => ({
	timestamp: i / 30,
	duration: 1 / 30,
}));

test.each(["preview", "export"])("%s video textures retain alpha when a frame surface is reused", (mode) =>
	withVideo(constantRate(1), async ({ file }) => {
		const renderer = rendererAt(mode === "preview" ? 0.25 : 1, mode === "export");
		const node = new RootNode({ duration: ticks(1) }).add(clip(file));
		const textureAt = async (time: number) => {
			const { textures } = await resolveFrame(renderer, node, time);
			const [texture] = textures;
			if (texture?.kind !== "external" || !(texture.source instanceof OffscreenCanvas)) {
				throw new Error("Missing video frame texture");
			}
			return texture.source;
		};
		try {
			const first = await textureAt(0);
			const ctx = first.getContext("2d")!;
			expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(255);
			expect(ctx.getImageData(first.width - 1, 0, 1, 1).data[3]).toBe(0);
			expect(await textureAt(1 / 30)).toBe(first);
			expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0);
			expect(ctx.getImageData(first.width - 1, 0, 1, 1).data[3]).toBe(255);
		} finally {
			renderer.videoCache.clear();
		}
	}, {
		width: 16, height: 16,
		draw: (ctx, frame) => {
			const half = ctx.canvas.width / 2;
			ctx.fillStyle = "red";
			ctx.fillRect(frame.timestamp === 0 ? 0 : half, 0, half, ctx.canvas.height);
		},
	}));

test("overlapping clips keep distinct source pixels and a matching blur background shares the decode", () =>
	withVideo(constantRate(12), async ({ file, starts, pixels }) => {
		const renderer = rendererAt();
		const lower = clip(file, 1);
		const upper = clip(file, 10);
		const backdrop = new BlurBackgroundNode({
			mediaId: "source", file, url: "blob:source", mediaType: "video",
			timeOffset: 0, duration: ticks(1), trimStart: ticks(1), trimEnd: 0, blurIntensity: 20,
		});
		const node = new RootNode({ duration: ticks(1) }).add(backdrop).add(lower).add(upper);
		try {
			for (const time of [0, 1 / 30]) {
				const { textures } = await resolveFrame(renderer, node, time);
				const sources = textures.filter((texture) => texture.kind === "external");
				expect(sources.map(({ version }) => version)).toEqual([1 + time, 10 + time]);
				expect(backdrop.resolved?.backdropSource.source).toBe(lower.resolved?.source);
				expect(sources.map(({ source }) => pixels.get(source as OffscreenCanvas)?.timestamp))
					.toEqual([1 + time, 10 + time]);
			}
			expect(starts).toEqual([1, 10]);
		} finally {
			renderer.videoCache.clear();
		}
	}));

test("quarter preview uploads 960 × 540 for 4K and increases its budget for a zoom; exact stays 4K", () =>
	withVideo(constantRate(1), async ({ file, starts }) => {
		const preview = rendererAt();
		const exact = rendererAt(0.25, true);
		const video = clip(file);
		const node = new RootNode({ duration: ticks(1) }).add(video);
		try {
			const quarter = await resolveFrame(preview, node, 0);
			expect(quarter.textures[0]).toMatchObject({ width: 960, height: 540 });
			video.params.transform.scaleX = 2;
			video.params.transform.scaleY = 2;
			const zoomed = await resolveFrame(preview, node, 1 / 30);
			expect(zoomed.textures[0]).toMatchObject({ width: 1920, height: 1080 });
			expect(zoomed.frame.items[0]).toMatchObject({ transform: { width: 1920, height: 1080 } });
			const captured = await resolveFrame(exact, node, 1 / 30);
			expect(captured.textures[0]).toMatchObject({ width: 3840, height: 2160 });
			expect(starts).toEqual([0, 1 / 30]);
		} finally {
			preview.videoCache.clear();
			exact.videoCache.clear();
		}
	}));

test("rotated portrait video preserves its layout and supplies enough pixels for a cover background", () =>
	withVideo(constantRate(1), async ({ file, starts }) => {
		const renderer = rendererAt();
		const video = clip(file);
		const backdrop = new BlurBackgroundNode({
			mediaId: "source", file, url: "blob:source", mediaType: "video",
			timeOffset: 0, duration: ticks(1), trimStart: 0, trimEnd: 0, blurIntensity: 20,
		});
		const node = new RootNode({ duration: ticks(1) }).add(backdrop).add(video);
		try {
			const { frame, textures } = await resolveFrame(renderer, node, 0);
			expect(frame.items[1]).toMatchObject({ transform: { width: 303.75, height: 540 } });
			expect(textures[1]).toMatchObject({ width: 382, height: 679 });
			expect(backdrop.resolved?.backdropSource.source).toMatchObject({ width: 1080, height: 1920 });
			expect(starts).toEqual([0]);
		} finally {
			renderer.videoCache.clear();
		}
	}, { width: 2160, height: 3840, rotation: 90 }));

test("exact video rasterization fits the device while retaining the original display geometry", () =>
	withVideo(constantRate(1), async ({ file, starts }) => {
		const cache = new VideoCache();
		try {
			const limited = await cache.getFrameAt({ file, time: 0, maxTextureDimension: 4096 });
			expect(limited).toMatchObject({
				canvas: { width: 2304, height: 4096 },
				sourceWidth: 4320,
				sourceHeight: 7680,
			});
			const full = await cache.getFrameAt({ file, time: 0, maxTextureDimension: 8192 });
			expect(full?.canvas).toMatchObject({ width: 4320, height: 7680 });
			expect(starts).toEqual([0]);
		} finally {
			cache.clear();
		}
	}, { width: 4320, height: 7680, rotation: 90 }));

test("interleaved preview and exact consumers keep their decode cursors and surfaces", () =>
	withVideo(constantRate(32), async ({ file, starts }) => {
		const preview = rendererAt();
		const exact = rendererAt(1, true);
		const previewTree = new RootNode({ duration: ticks(31) }).add(clip(file));
		const exactTree = new RootNode({ duration: ticks(31) }).add(clip(file));
		try {
			for (let index = 0; index < 5; index++) {
				const low = await resolveFrame(preview, previewTree, 30 + index / 30);
				const full = await resolveFrame(exact, exactTree, index / 30);
				expect(low.textures[0]).toMatchObject({ version: 30 + index / 30, width: 960, height: 540 });
				expect(full.textures[0]).toMatchObject({ version: index / 30, width: 3840, height: 2160 });
			}
			expect(starts).toEqual([30, 0]);
		} finally {
			preview.videoCache.clear();
			exact.videoCache.clear();
		}
	}));

test.each([{ duration: 0 }, { duration: 0.033 }])("timestamp gaps retain the active sample with duration $duration", ({ duration }) => {
	const frames = Array.from({ length: 12 }, (_, index) => ({ timestamp: index * 0.034, duration }));
	return withVideo(frames, async ({ file, starts, decoded }) => {
		const cache = new VideoCache();
		try {
			for (let index = 0; index < 10; index++) {
				const timestamp = frames[index].timestamp;
				const atStart = await cache.getFrameAt({ file, time: timestamp });
				cache.finishFrame();
				const inGap = await cache.getFrameAt({ file, time: timestamp + 0.0335 });
				cache.finishFrame();
				expect(atStart?.timestamp).toBe(timestamp);
				expect(inGap?.timestamp).toBe(timestamp);
				expect(inGap?.canvas).toBe(atStart?.canvas);
			}
			expect(starts).toEqual([0]);
			expect(decoded).toHaveLength(11);
		} finally {
			cache.clear();
		}
	});
});

test("skipped display ticks keep the cursor current after two seconds of playback", () =>
	withVideo(constantRate(3), async ({ file, starts, decoded, closed }) => {
		const cache = new VideoCache();
		try {
			for (let index = 0; index < 65; index++) {
				const frame = await cache.getFrameAt({ file, time: index / 30 });
				expect(frame?.timestamp).toBe(index / 30);
				cache.finishFrame();
			}
			const skipped = await cache.getFrameAt({ file, time: 67 / 30 });
			expect(skipped?.timestamp).toBe(67 / 30);
			expect(starts).toEqual([0]);
			cache.finishFrame();
			cache.finishFrame(); // The track has no visible use on this output frame.
			await Promise.resolve();
			expect(closed).toEqual(decoded);
		} finally {
			cache.clear();
		}
	}));

test("a delayed first sample is visible before its presentation timestamp without repeated seeks", () =>
	withVideo([
		{ timestamp: 0.5, duration: 0.05 },
		{ timestamp: 0.6, duration: 0.05 },
	], async ({ file, starts }) => {
		const cache = new VideoCache();
		try {
			for (const [time, timestamp] of [[0, 0.5], [0.25, 0.5], [0.56, 0.5], [0.6, 0.6]]) {
				expect((await cache.getFrameAt({ file, time }))?.timestamp).toBe(timestamp);
				cache.finishFrame();
			}
			expect(starts).toEqual([0]);
		} finally {
			cache.clear();
		}
	}));

test("leaving an outer compound drops the video surfaces held by nested nodes", () =>
	withVideo(constantRate(1), async ({ file }) => {
		const renderer = rendererAt();
		const video = clip(file);
		const inner = new CompoundNode({
			...video.params,
			content: new RootNode({ duration: ticks(1) }).add(video),
		});
		const outer = new CompoundNode({
			...video.params, duration: ticks(1),
			content: new RootNode({ duration: ticks(1) }).add(inner),
		});
		const root = new RootNode({ duration: ticks(2) }).add(outer);
		try {
			// Resolve only: descriptor construction for a compound needs the real compositor.
			await resolveRenderTree({ renderer, node: root, time: 0 });
			renderer.videoCache.finishFrame();
			expect(video.resolved?.source).toBeInstanceOf(TestCanvas);
			await resolveRenderTree({ renderer, node: root, time: ticks(1) });
			renderer.videoCache.finishFrame();
			expect(video.resolved).toBeNull();
		} finally {
			renderer.videoCache.clear();
		}
	}));

test("identical requests share a frame while distinct exact times remain available", () =>
	withVideo(constantRate(4), async ({ file, starts }) => {
		const cache = new VideoCache();
		try {
			const get = (time: number) => cache.getFrameAt({ file, time });
			const [early, middle, duplicate, late] = await Promise.all([get(0), get(1), get(1), get(3)]);
			expect([early?.timestamp, middle?.timestamp, late?.timestamp]).toEqual([0, 1, 3]);
			expect(duplicate).toBe(middle);
			expect(starts).toEqual([0, 1, 3]);
		} finally {
			cache.clear();
		}
	}));

test.each([
	{ seekError: undefined, message: "No video frames could be decoded" },
	{ seekError: new Error("Invalid packet"), message: "Invalid packet" },
])("strict export reads report $message", ({ seekError, message }) =>
	withVideo([], async ({ file }) => {
		const cache = new VideoCache();
		try {
			await expect(cache.getFrameAt({ file, time: 0, throwOnSeekError: true })).rejects.toThrow(message);
		} finally {
			cache.clear();
		}
	}, { seekError }));

test("a full-resolution snapshot can omit a failed video seek", () =>
	withVideo([], async ({ file }) => {
		const snapshot = rendererAt(1, true);
		try {
			const root = new RootNode({ duration: ticks(1) }).add(clip(file));
			const { textures } = await resolveFrame(snapshot, root, 0);
			expect(textures).toEqual([]);
		} finally {
			snapshot.videoCache.clear();
		}
	}, { seekError: new Error("Invalid packet") }));

test("preview keeps drawing other layers and only opens a broken video once", () =>
	withVideo(constantRate(1), async ({ file }) => {
		const renderer = rendererAt();
		const broken = clip(new File(["broken"], "broken.mp4"), 0, 1, "broken");
		const node = new RootNode({ duration: ticks(1) }).add(broken).add(clip(file));
		const open = spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValueOnce(null);
		const disposed = spyOn(Input.prototype, "dispose");
		try {
			for (const time of [0, 1 / 30]) {
				const { frame } = await resolveFrame(renderer, node, time);
				expect(frame.items).toHaveLength(1);
				expect(broken.resolved).toBeNull();
			}
			expect(open).toHaveBeenCalledTimes(2);
			expect(disposed).toHaveBeenCalledTimes(1);
		} finally {
			renderer.videoCache.clear();
			disposed.mockRestore();
		}
	}));

test.each([0, 2])("strict reads distinguish a held last frame from an early end (last packet at %d)", (lastPacketTime) =>
	withVideo([{ timestamp: 0, duration: 1 }], async ({ file }) => {
		const cache = new VideoCache();
		const packet = spyOn(EncodedPacketSink.prototype, "getPacket")
			.mockResolvedValue(new EncodedPacket(Uint8Array.of(1), "key", lastPacketTime, 1));
		try {
			const read = (time: number) => cache.getFrameAt({ file, time, throwOnSeekError: true });
			expect((await read(0))?.timestamp).toBe(0);
			cache.finishFrame();
			if (lastPacketTime === 0) expect((await read(1))?.timestamp).toBe(0);
			else await expect(read(1)).rejects.toThrow("Video decoding ended before the last packet");
			expect(packet).toHaveBeenCalledWith(Infinity, { metadataOnly: true });
		} finally {
			cache.clear();
			packet.mockRestore();
		}
	}));
