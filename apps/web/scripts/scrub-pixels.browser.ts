import { BlobSource, EncodedPacket, EncodedPacketSink, Input, InputVideoTrack, VideoSample, VideoSampleSink } from "mediabunny";
import { registerDefaultEffects } from "../src/effects";
import { registerDefaultMasks } from "../src/masks";
import { CanvasRenderer } from "../src/services/renderer/canvas-renderer";
import { getRendererAdapter, rendererDevice } from "../src/services/renderer/renderer-device";
import { ColorNode } from "../src/services/renderer/nodes/color-node";
import { RootNode } from "../src/services/renderer/nodes/root-node";
import { TextNode } from "../src/services/renderer/nodes/text-node";
import { VideoNode, type VideoNodeParams } from "../src/services/renderer/nodes/video-node";
import { ScrubVideoCache } from "../src/services/video-cache/scrub-cache";
import { DEFAULTS } from "../src/timeline/defaults";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "../src/wasm";

const at = 0.5;
const duration = mediaTimeFromSeconds({ seconds: 1 });
const time = mediaTimeFromSeconds({ seconds: at });
const fps = { numerator: 30, denominator: 1 };
const tracks = new WeakMap<File, InputVideoTrack>();
const sources = new WeakMap<InputVideoTrack, OffscreenCanvas>();

// Supply the same presentation timestamp to both caches. Rasterization,
// rotation, resolution, and the GPU compositor all use the production paths.
Input.prototype.getPrimaryVideoTrack = async function (this: Input) {
	const source = this.source as BlobSource & { _blob: File };
	return tracks.get(source._blob) ?? null;
};
const sinkTrack = (sink: VideoSampleSink) => (sink as VideoSampleSink & { _track: InputVideoTrack })._track;
VideoSampleSink.prototype.samples = async function* (this: VideoSampleSink) {
	const source = sources.get(sinkTrack(this));
	if (!source) throw new Error("Missing pixel fixture");
	yield new VideoSample(source, { timestamp: at, duration: 0.1 });
};
VideoSampleSink.prototype.samplesAtTimestamps = async function* (this: VideoSampleSink) {
	yield* this.samples();
};
EncodedPacketSink.prototype.getKeyPacket = async () => new EncodedPacket(Uint8Array.of(1), "key", at, 0.1);
EncodedPacketSink.prototype.getNextKeyPacket = async () => null;

function video(width: number, height: number, changes: Partial<VideoNodeParams> = {}, rotation = 0, alpha = false) {
	const file = new File([], "fixture.mp4");
	const source = new OffscreenCanvas(rotation ? height : width, rotation ? width : height);
	const ctx = source.getContext("2d")!;
	const gradient = ctx.createLinearGradient(0, 0, source.width, source.height);
	gradient.addColorStop(0, alpha ? "#ffc45443" : "#165580");
	gradient.addColorStop(1, alpha ? "#ef517abf" : "#d5904b");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, source.width, source.height);
	ctx.fillStyle = alpha ? "#79c8e257" : "#62c7ad";
	ctx.fillRect(source.width / 8, source.height / 6, source.width / 3, source.height / 4);
	const track: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: width },
		displayHeight: { value: height },
		rotation: { value: rotation },
		canDecode: { value: async () => true },
	});
	tracks.set(file, track);
	sources.set(track, source);
	return new VideoNode({
		file, url: "", mediaId: "fixture", duration, timeOffset: 0, trimStart: 0, trimEnd: 0,
		transform: DEFAULTS.element.transform, opacity: 1, ...changes,
	});
}

const cases = {
	mask(root: RootNode, w: number, h: number) {
		root.add(video(w, h, { masks: [{
			id: "rectangle", type: "rectangle",
			params: {
				centerX: 0, centerY: 0, width: 0.54, height: 0.62, scale: 1, rotation: 9,
				inverted: false, feather: 0, strokeAlign: "center", strokeColor: "#fef800", strokeWidth: 12,
			},
		}] }));
	},
	effect(root: RootNode, w: number, h: number) {
		root.add(video(w, h, { effects: [{ id: "blur", type: "blur", enabled: true, params: { intensity: 60 } }] }));
	},
	alpha(root: RootNode, w: number, h: number) {
		root.add(video(w, h)).add(video(w, h, {
			transform: { scaleX: 0.65, scaleY: 0.65, position: { x: 31, y: -17 }, rotate: 11 },
		}, 0, true));
	},
	outline(root: RootNode, w: number, h: number) {
		const text = DEFAULTS.text.element;
		root.add(video(w, h)).add(new TextNode({
			...text, id: "outline", canvasCenter: { x: w / 2, y: h / 2 }, canvasHeight: h,
			transform: DEFAULTS.element.transform, opacity: 1,
			params: { ...text.params, content: "Cut 12", fontSize: 20, "stroke.outer.widthPx": 9, "stroke.outer.color": "#ffed00" },
		}));
	},
	transition(root: RootNode, w: number, h: number) {
		// The crossfade uses an outgoing continuation above the incoming clip.
		root.add(video(w, h)).add(video(w, h, {
			animations: {
				opacity: { keys: [
					{ id: "fade-start", time: ZERO_MEDIA_TIME, value: 1, segmentToNext: "linear", tangentMode: "auto" },
					{ id: "fade-end", time: duration, value: 0, segmentToNext: "linear", tangentMode: "auto" },
				] },
			},
		}, 0, true));
	},
	rotation(root: RootNode, w: number, h: number) {
		root.add(video(w, h, {}, 90));
	},
};

function pixels(canvas: HTMLCanvasElement, width: number, height: number) {
	const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(canvas, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height).data;
}

async function compare(name: string, root: RootNode, width: number, height: number) {
	const exact = new CanvasRenderer({ width, height, fps });
	const drag = new CanvasRenderer({ width, height, fps });
	const cache = new ScrubVideoCache();
	const requireSourceFrames = () => {
		for (const node of root.children) {
			if (node instanceof VideoNode && node.resolved?.sourceVersion !== at) {
				throw new Error(`${name} did not use the fixture's exact decoded frame`);
			}
		}
	};
	try {
		await exact.render({ node: root, time });
		if (exact.outputWidth !== width || exact.outputHeight !== height) throw new Error(`${name} did not render at exact size`);
		requireSourceFrames();
		for (let attempt = 0; attempt < 12; attempt++) {
			let blocked = false;
			const ready = Promise.withResolvers<void>();
			await drag.render({
				node: root, time,
				scrub: { cache, onReady: ready.resolve, onBlocked: () => { blocked = true; } },
			});
			if (!blocked) break;
			if (attempt === 11) throw new Error(`${name} never presented a scrub frame`);
			await Promise.race([ready.promise, new Promise((resolve) => setTimeout(resolve, 20))]);
		}
		const { width: w, height: h } = drag.getOutputCanvas();
		if (Math.max(w, h) !== 640 || w * height !== h * width) throw new Error(`${name} changed framing`);
		requireSourceFrames();
		const expected = pixels(exact.getOutputCanvas(), w, h);
		const actual = pixels(drag.getOutputCanvas(), w, h);
		let total = 0;
		let outliers = 0;
		const outline = (data: Uint8ClampedArray, i: number) => data[i] > 215 && data[i + 1] > 200 && data[i + 2] < 50;
		let exactOutline = 0;
		let scrubOutline = 0;
		for (let i = 0; i < expected.length; i += 4) {
			const red = Math.abs(expected[i] - actual[i]);
			const green = Math.abs(expected[i + 1] - actual[i + 1]);
			const blue = Math.abs(expected[i + 2] - actual[i + 2]);
			total += red + green + blue;
			if (Math.max(red, green, blue) > 24) outliers++;
			if (outline(expected, i)) exactOutline++;
			if (outline(actual, i)) scrubOutline++;
		}
		if (/(mask|outline)$/.test(name) &&
			(exactOutline < 20 || Math.abs(exactOutline - scrubOutline) / exactOutline > 0.12)) {
			throw new Error(`${name} changed outline coverage (${exactOutline} versus ${scrubOutline} pixels)`);
		}
		const mean = total / (w * h * 3);
		const outlierFraction = outliers / (w * h);
		// Resampling can change antialiased edge pixels. Bound both the overall error and its area.
		if (mean > 2.5 || outlierFraction > 0.018) {
			throw new Error(`${name} differs at rest (mean ${mean}, outlier fraction ${outlierFraction})`);
		}
		return { name, mean, outlierFraction };
	} finally {
		cache.clear();
		exact.videoCache.clear();
		drag.videoCache.clear();
	}
}

async function run() {
	registerDefaultEffects();
	registerDefaultMasks();
	await rendererDevice.start();
	await document.fonts.ready;
	const results = [];
	const errors: string[] = [];
	for (const [width, height] of [[1280, 720], [720, 1280]]) {
		for (const [name, add] of Object.entries(cases)) {
			const root = new RootNode({ duration }).add(new ColorNode({ color: "#1c2333" }));
			add(root, width, height);
			try {
				results.push(await compare(`${width}x${height} ${name}`, root, width, height));
			} catch (error) {
				errors.push(String(error));
			}
		}
	}
	return { adapter: await getRendererAdapter(), results, errors };
}

void run().then((result) => {
	document.body.dataset.result = JSON.stringify(result);
}, (error: unknown) => {
	document.body.dataset.result = JSON.stringify({ error: String(error) });
});
