import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { renderTargetSize } from "./scale";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import type { ProxyInfo } from "@/services/proxies/mapping";
import { waitWithAbort } from "@/utils/abort";
import { VideoCache } from "@/services/video-cache/service";
import { MIN_GPU_CANVAS_DIMENSION, previewCanvasSize } from "@/canvas/sizes";
import { canvasSizeError, checkGraphicsContext, getRendererLimits, rendererDevice, rethrowGraphicsFailure } from "./renderer-device";
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
	 * Keep video textures at source resolution up to the device limit.
	 */
	exactFrames?: boolean;
	/** Exports and snapshots must match the requested size. */
	requireFullSize?: boolean;
	strictVideoDecoding?: boolean;
	/** Export reports source decode failures in its missing-media result. */
	onMediaFailure?: (mediaId: string, error: unknown) => void;
};

// The WASM compositor and its textures are shared by all renderers.
let renderQueue: Promise<void> = Promise.resolve();
type ProxyRender = {
	proxies: ReadonlyMap<string, { info: ProxyInfo; file: File }>;
	valid: () => boolean;
};

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;
	private requestedScale: number;
	private target: { width: number; height: number; scale: number };
	private outputCanvas: HTMLCanvasElement;
	private requireFullSize: boolean;

	readonly exactFrames: boolean;
	readonly strictVideoDecoding: boolean;
	readonly onMediaFailure?: CanvasRendererParams["onMediaFailure"];
	readonly failedMediaIds = new Set<string>();
	readonly videoCache = new VideoCache();

	constructor({ width, height, fps, renderScale = 1, exactFrames = false, requireFullSize = false, strictVideoDecoding = false, onMediaFailure }: CanvasRendererParams) {
		this.exactFrames = exactFrames;
		this.strictVideoDecoding = strictVideoDecoding;
		this.onMediaFailure = onMediaFailure;
		const size = requireFullSize ? { width, height } : previewCanvasSize({ width, height });
		this.width = size.width;
		this.height = size.height;
		this.fps = fps;
		this.requestedScale = renderScale;
		this.requireFullSize = requireFullSize;
		const { maxSurfaceDimension } = getRendererLimits();
		this.target = this.getRenderTarget(maxSurfaceDimension);
		this.outputCanvas = document.createElement("canvas");
		if (maxSurfaceDimension !== undefined || Math.max(this.outputWidth, this.outputHeight) <= MIN_GPU_CANVAS_DIMENSION) {
			this.resizeOutputCanvas();
		}
	}

	get renderScale() { return this.target.scale; }
	get outputWidth() { return this.target.width; }
	get outputHeight() { return this.target.height; }

	private getRenderTarget(max = Infinity) {
		const { width, height } = this;
		if (this.requireFullSize) {
			const error = canvasSizeError({ width, height }, max);
			if (error) throw new Error(error);
		}
		const scale = Math.min(this.requestedScale, max / Math.max(width, height));
		return { ...renderTargetSize({ width, height, scale }), scale };
	}

	private resizeOutputCanvas() {
		if (this.outputCanvas.width !== this.outputWidth) this.outputCanvas.width = this.outputWidth;
		if (this.outputCanvas.height !== this.outputHeight) this.outputCanvas.height = this.outputHeight;
	}

	getOutputCanvas(): HTMLCanvasElement {
		return this.outputCanvas;
	}

	async render({ node, time, signal, proxy }: { node: AnyBaseNode; time: number; signal?: AbortSignal; proxy?: ProxyRender }) {
		return this.renderToCanvas({ node, time, signal, proxy, targetCanvas: this.outputCanvas });
	}

	private async renderFrame({
		node,
		time,
		signal,
		targetCanvas,
		proxy,
	}: {
		node: AnyBaseNode;
		time: number;
		signal: AbortSignal;
		targetCanvas: HTMLCanvasElement;
		proxy?: ProxyRender;
	}) {
		const { maxSurfaceDimension, maxTextureDimension } = getRendererLimits();
		this.target = this.getRenderTarget(maxSurfaceDimension);
		if (targetCanvas !== this.outputCanvas) {
			const error = canvasSizeError(targetCanvas, maxSurfaceDimension);
			if (error) throw new Error(error);
		}
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time, signal, proxies: proxy?.proxies }),
		});
		signal.throwIfAborted();
		if (proxy && !proxy.valid()) throw new DOMException("Scrub target changed", "AbortError");
		checkGraphicsContext();
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this, signal }),
		});
		signal.throwIfAborted();
		if (proxy && !proxy.valid()) throw new DOMException("Scrub target changed", "AbortError");
		checkGraphicsContext();
		wasmCompositor.ensureInitialized({
			width: this.outputWidth,
			height: this.outputHeight,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures, { maxTextureDimension }),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});

		// WebGL effects share the staging surface. Present and copy without yielding.
		checkGraphicsContext();
		if (targetCanvas === this.outputCanvas) this.resizeOutputCanvas();
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
		proxy,
		signal,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
		proxy?: ProxyRender;
		signal?: AbortSignal;
	}) {
		signal?.throwIfAborted();
		const generation = rendererDevice.requireReady();
		const frameSignal = signal ? AbortSignal.any([signal, generation]) : generation;
		const task = renderQueue.then(async () => {
			frameSignal.throwIfAborted();
			checkGraphicsContext();
			await this.renderFrame({ node, time, signal: frameSignal, targetCanvas, proxy });
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
