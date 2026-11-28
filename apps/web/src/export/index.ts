import type { FrameRate } from "opencut-wasm";
import type { GraphicsIssueKind } from "@/services/renderer/device-lifecycle";
import type { CanvasSizeIssue } from "@/services/renderer/renderer-device";
import type { MediaLoadFailure } from "@/media/types";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
	/** Explicitly allow export when referenced media are missing. */
	allowMissing?: boolean;
	/** Export this scene (for example the root timeline) instead of the open one. */
	sceneId?: string;
	/** The video's shorter side in pixels, smaller than the canvas's (a quick preview). Unset: the canvas size. */
	size?: number;
}

/** The smallest and largest `size` an export accepts. */
export const EXPORT_SIZE_MIN = 144;
export const EXPORT_SIZE_MAX = 4320;

/**
 * The video size of an export: the canvas, or the canvas scaled so its shorter side is `size`, with
 * both sides kept even where a scale allows it (MP4 needs even sides). `scale` is what the renderer
 * draws the canvas at.
 */
export function exportOutputSize({ canvas, size }: { canvas: { width: number; height: number }; size?: number }) {
	const short = Math.min(canvas.width, canvas.height);
	if (!size || size >= short) return { width: canvas.width, height: canvas.height, scale: 1 };
	const long = Math.max(canvas.width, canvas.height);
	const sides = (scale: number) => ({
		width: Math.max(1, Math.round(canvas.width * scale)),
		height: Math.max(1, Math.round(canvas.height * scale)),
		scale,
	});
	const even = Math.max(2, Math.round(size / 2) * 2);
	const first = sides(even / short);
	if (first.width % 2 === 0 && first.height % 2 === 0) return first;
	// Move the longer side to the nearest even lengths until both sides round to even numbers.
	const base = Math.round((long * even) / short / 2) * 2;
	for (let step = 0; step <= 8; step++) {
		for (const candidate of step ? [base + 2 * step, base - 2 * step] : [base]) {
			const next = sides(candidate / long);
			if (next.width % 2 === 0 && next.height % 2 === 0) return next;
		}
	}
	return first;
}

export type ExportIssue =
	| CanvasSizeIssue
	| { kind: "evenDimensions"; width: number; height: number }
	| { kind: "alreadyRunning" | "reviewRunning" | "empty" | "sceneNotFound" | "noProject" | "noBuffer" | GraphicsIssueKind };

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	issue?: ExportIssue;
	missingMedia?: MediaLoadFailure[];
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
