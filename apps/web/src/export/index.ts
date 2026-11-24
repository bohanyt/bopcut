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
