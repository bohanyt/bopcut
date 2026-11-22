import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { renderTargetSize } from "./scale";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import { waitWithAbort } from "@/utils/abort";
import { VideoCache } from "@/services/video-cache/service";
import { checkGraphicsContext, rendererDevice, rethrowGraphicsFailure } from "./renderer-device";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
	/** Preview target scale; project coordinates remain unchanged. */
	renderScale?: number;
	/**
	 * Keep video textures at source resolution for exports, snapshots, and thumbnails.
	 */
	exactFrames?: boolean;
	/** Export reports source decode failures in its missing-media result. */
	onMediaFailure?: (mediaId: string, error: unknown) => void;
};

// The WASM compositor and its textures are shared by all renderers.
let renderQueue: Promise<void> = Promise.resolve();

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;
	renderScale: number;
	outputWidth: number;
	outputHeight: number;
	private outputCanvas: HTMLCanvasElement;

	readonly exactFrames: boolean;
	readonly onMediaFailure?: CanvasRendererParams["onMediaFailure"];
	readonly failedMediaIds = new Set<string>();
	readonly videoCache = new VideoCache();

	constructor({ width, height, fps, renderScale = 1, exactFrames = false, onMediaFailure }: CanvasRendererParams) {
		this.exactFrames = exactFrames;
		this.onMediaFailure = onMediaFailure;
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.renderScale = renderScale;
		const target = renderTargetSize({ width, height, scale: renderScale });
		this.outputWidth = target.width;
		this.outputHeight = target.height;
		this.outputCanvas = document.createElement("canvas");
		this.outputCanvas.width = this.outputWidth;
		this.outputCanvas.height = this.outputHeight;
	}

	getOutputCanvas(): HTMLCanvasElement {
		return this.outputCanvas;
	}

	async render({ node, time, signal }: { node: AnyBaseNode; time: number; signal?: AbortSignal }) {
		return this.renderToCanvas({ node, time, signal, targetCanvas: this.outputCanvas });
	}

	private async renderFrame({
		node,
		time,
		signal,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		signal: AbortSignal;
		targetCanvas: HTMLCanvasElement;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time, signal }),
		});
		signal.throwIfAborted();
		checkGraphicsContext();
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this, signal }),
		});
		signal.throwIfAborted();
		checkGraphicsContext();
		wasmCompositor.ensureInitialized({
			width: this.outputWidth,
			height: this.outputHeight,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});

		// WebGL effects share the staging surface. Present and copy without yielding.
		checkGraphicsContext();
		const ctx = targetCanvas.getContext("2d");
		if (!ctx) throw new Error("Failed to get target canvas context");
		measureSpanSync({
			name: "drawImage",
			fn: () => ctx.drawImage(wasmCompositor.getCanvas(), 0, 0, targetCanvas.width, targetCanvas.height),
		});
		rendererDevice.markFramePresented();
		onRenderPerfFrameComplete();
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
		signal,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
		signal?: AbortSignal;
	}) {
		signal?.throwIfAborted();
		const generation = rendererDevice.requireReady();
		const frameSignal = signal ? AbortSignal.any([signal, generation]) : generation;
		const task = renderQueue.then(async () => {
			frameSignal.throwIfAborted();
			checkGraphicsContext();
			await this.renderFrame({ node, time, signal: frameSignal, targetCanvas });
		}).catch((error: unknown) => {
			frameSignal.throwIfAborted();
			rethrowGraphicsFailure(error);
		}).finally(() => {
			if (frameSignal.aborted) this.videoCache.clear();
			else this.videoCache.finishFrame();
		});
		renderQueue = task.catch(() => {});
		return waitWithAbort(task, frameSignal);
	}
}
