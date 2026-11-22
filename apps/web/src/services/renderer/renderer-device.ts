import { getGpuWebGlCanvas, initializeGpu, resetGpu } from "opencut-wasm";
import { DeviceLifecycle, GraphicsDeviceError } from "./device-lifecycle";
import { wasmCompositor } from "./compositor/wasm-compositor";

let gl: WebGL2RenderingContext | null = null;
let detachContextListener: (() => void) | undefined;
let notifyLoss: (() => void) | undefined;

function disposeGpu() {
	detachContextListener?.();
	detachContextListener = undefined;
	notifyLoss = undefined;
	gl = null;
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
		const canvas = getGpuWebGlCanvas();
		if (!canvas) return;
		gl = canvas.getContext("webgl2");
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
		throw new GraphicsDeviceError("The graphics surface is temporarily unavailable. Try again.");
	}
	throw error;
}
