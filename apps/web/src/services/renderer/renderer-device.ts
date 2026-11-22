import { getGpuWebGlCanvas, getMaxTextureDimension2D, initializeGpu, resetGpu } from "opencut-wasm";
import { DeviceLifecycle, GraphicsDeviceError } from "./device-lifecycle";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { isValidCanvasSize } from "@/canvas/sizes";
import type { TCanvasSize } from "@/project/types";

let gl: WebGL2RenderingContext | null = null;
let detachContextListener: (() => void) | undefined;
let notifyLoss: (() => void) | undefined;
const noLimits: { maxTextureDimension?: number; maxSurfaceDimension?: number } = {};
let limits = noLimits;

export class RecoverableSurfaceError extends GraphicsDeviceError {}

function disposeGpu() {
	detachContextListener?.();
	detachContextListener = undefined;
	notifyLoss = undefined;
	gl = null;
	limits = noLimits;
	wasmCompositor.reset();
	resetGpu();
}

export const rendererDevice = new DeviceLifecycle({
	async initialize(onLost) {
		disposeGpu();
		const lost = () => {
			onLost();
			// A device callback must not reenter Rust while it is using the runtime.
			queueMicrotask(() => {
				if (notifyLoss === lost) disposeGpu();
			});
		};
		notifyLoss = lost;
		await initializeGpu(lost);
		const maxTextureDimension = getMaxTextureDimension2D();
		limits = { maxTextureDimension, maxSurfaceDimension: maxTextureDimension };
		const canvas = getGpuWebGlCanvas();
		if (!canvas) return;
		gl = canvas.getContext("webgl2");
		if (gl && !gl.isContextLost() && maxTextureDimension !== undefined) {
			const viewport: Int32Array | null = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
			const renderbuffer: number | null = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
			if (viewport?.[0] && viewport[1] && renderbuffer) {
				limits.maxSurfaceDimension = Math.min(maxTextureDimension, viewport[0], viewport[1], renderbuffer);
			}
		}
		const onContextLost = (event: Event) => {
			event.preventDefault();
			lost();
		};
		canvas.addEventListener("webglcontextlost", onContextLost);
		detachContextListener = () => canvas.removeEventListener("webglcontextlost", onContextLost);
		if (gl?.isContextLost()) lost();
	},
	scheduleRecovery: (recover) => setTimeout(recover, 250),
});

export function getRendererLimits() {
	return rendererDevice.status.state === "ready" ? limits : noLimits;
}

export type CanvasSizeIssue =
	| { kind: "canvasInvalid" }
	| { kind: "canvasOverLimit"; width: number; height: number; max: number };

export function getCanvasSizeIssue({ width, height }: TCanvasSize, max = getRendererLimits().maxSurfaceDimension): CanvasSizeIssue | undefined {
	if (!isValidCanvasSize({ width, height })) return { kind: "canvasInvalid" };
	if (max !== undefined && Math.max(width, height) > max) {
		return { kind: "canvasOverLimit", width, height, max };
	}
}

export function canvasSizeError(size: TCanvasSize, max?: number): string | undefined {
	const issue = getCanvasSizeIssue(size, max);
	return issue && describeCanvasSizeIssue(issue);
}

export function describeCanvasSizeIssue(issue: CanvasSizeIssue): string {
	if (issue.kind === "canvasInvalid") {
		return "Canvas width and height must be positive whole numbers.";
	}
	const { width, height, max } = issue;
	return `The ${width} × ${height} canvas exceeds this graphics device’s limit of ${max} pixels per side. Reduce the canvas size in Project Settings.`;
}

export function isGraphicsInitializing(): boolean {
	const { state } = rendererDevice.status;
	return state === "starting" || state === "recovering";
}

export function checkGraphicsContext(): void {
	const signal = rendererDevice.requireReady();
	if (gl?.isContextLost()) notifyLoss?.();
	signal.throwIfAborted();
}

export function rethrowGraphicsFailure(error: unknown): never {
	if (error === "GPU_SURFACE_LOST" || gl?.isContextLost()) {
		const signal = rendererDevice.signal;
		notifyLoss?.();
		signal.throwIfAborted();
	}
	if (error === "GPU_SURFACE_UNAVAILABLE") {
		throw new RecoverableSurfaceError("The graphics surface is temporarily unavailable. Try again.");
	}
	if (error instanceof Error && error.name === "WebGlOperationError") {
		throw new RecoverableSurfaceError(error.message, { cause: error });
	}
	throw error;
}
