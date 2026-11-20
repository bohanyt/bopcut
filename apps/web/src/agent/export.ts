// Exports for agents: `export-request.json` asks the open editor to export the timeline into the
// workspace's `exports/` folder; progress and the result go to `export-result.json`.
import { EXPORT_FORMAT_VALUES, EXPORT_QUALITY_VALUES, type ExportFormat, type ExportQuality } from "@/export";

export type ExportRequest = {
	rev: string;
	projectId?: string;
	/** File name without extension (default: the project's name and the time). */
	name?: string;
	format: ExportFormat;
	quality: ExportQuality;
	/** Frames per second (default: the project's). */
	fps?: number;
	includeAudio: boolean;
	/** Export even if stored media could not be loaded (they would be missing from the video). */
	allowMissing: boolean;
};

const REV = /^[a-zA-Z0-9_-]{1,100}$/;

/** A request from `export-request.json`, checked; a message when it is not valid; null when there is none. */
export function parseExportRequest(value: unknown): ExportRequest | string | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.rev !== "string" || !REV.test(raw.rev)) return null;
	const format = raw.format ?? "mp4";
	if (!EXPORT_FORMAT_VALUES.includes(format as ExportFormat)) return `format must be one of ${EXPORT_FORMAT_VALUES.join(", ")}`;
	const quality = raw.quality ?? "high";
	if (!EXPORT_QUALITY_VALUES.includes(quality as ExportQuality)) return `quality must be one of ${EXPORT_QUALITY_VALUES.join(", ")}`;
	if (raw.fps !== undefined && (typeof raw.fps !== "number" || !Number.isFinite(raw.fps) || raw.fps < 1 || raw.fps > 240)) return "fps must be 1 to 240";
	if (raw.name !== undefined && (typeof raw.name !== "string" || !safeName(raw.name))) return "name must have letters or digits (no folders)";
	if (raw.projectId !== undefined && typeof raw.projectId !== "string") return "projectId must be a string";
	return {
		rev: raw.rev,
		...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
		...(typeof raw.name === "string" ? { name: raw.name } : {}),
		format: format as ExportFormat,
		quality: quality as ExportQuality,
		...(typeof raw.fps === "number" ? { fps: raw.fps } : {}),
		includeAudio: raw.includeAudio !== false,
		allowMissing: raw.allowMissing === true,
	};
}

/**
 * A file name from any text: letters, digits, spaces, dots, dashes and underscores only, at most 80
 * characters, never a Windows device name (`con`, `nul`, `com1`...: those get a `_`).
 */
export function safeName(text: string): string {
	const name = text.normalize("NFC").replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/\.{2,}/g, ".").replace(/^[\s.-]+|[\s.-]+$/g, "").slice(0, 80).trim();
	return /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i.test(name) ? name.replace(/^[^.]*/, (base) => `${base}_`) : name;
}

/** The default export name: the project's name and the local time (e.g. `My clip 2026-11-20 14-05-09`). */
export function defaultExportName(projectName: string, now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	return safeName(`${projectName} ${stamp}`) || `export ${stamp}`;
}
