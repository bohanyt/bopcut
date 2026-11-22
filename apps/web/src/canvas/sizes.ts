import type { TCanvasSize } from "@/project/types";

export const DEFAULT_CANVAS_PRESETS: TCanvasSize[] = [
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
	{ width: 1440, height: 1080 },
];

export const DEFAULT_CANVAS_SIZE: TCanvasSize = { width: 1920, height: 1080 };

// The minimum texture size guaranteed by WebGL2 also fits WebGPU.
export const MIN_GPU_CANVAS_DIMENSION = 2048;

export function isValidCanvasSize({ width, height }: TCanvasSize): boolean {
	return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
}

export function previewCanvasSize(size: TCanvasSize): TCanvasSize {
	return isValidCanvasSize(size) ? size : DEFAULT_CANVAS_SIZE;
}
