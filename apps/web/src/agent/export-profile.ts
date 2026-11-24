import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "@/services/storage/server/files";
import { fileInside } from "./inside";

const filename = (relative: string) => createHash("sha256").update(relative).digest("hex") + ".json";
export function exportSceneSettings(value: Record<string, unknown>) {
	const range = value.range as { from?: unknown; to?: unknown } | undefined;
	return {
		...(typeof value.sceneId === "string" && { sceneId: value.sceneId }),
		...(typeof value.includeAudio === "boolean" && { includeAudio: value.includeAudio }),
		...(range && typeof range.from === "number" && typeof range.to === "number" && Number.isFinite(range.from) &&
			Number.isFinite(range.to) && range.from >= 0 && range.to > range.from && { range: { from: range.from, to: range.to } }),
	};
}

export async function saveExportProfile(workspace: string, exportFile: string, result: Record<string, unknown>) {
	if (typeof result.projectId !== "string" || typeof result.width !== "number" || typeof result.height !== "number" || typeof result.fps !== "number") return;
	const dir = path.join(workspace, "export-profiles");
	await fs.mkdir(dir, { recursive: true });
	if (!(await fs.lstat(dir)).isDirectory()) return;
	const stat = await fs.stat(path.join(workspace, exportFile));
	await atomicWrite(path.join(dir, filename(exportFile)), JSON.stringify({
		projectId: result.projectId, file: exportFile, bytes: stat.size, mtimeMs: stat.mtimeMs,
		width: result.width, height: result.height, fps: result.fps,
		...exportSceneSettings(result),
	}));
}

export async function knownExportProfile(workspace: string, projectId: string, file: string, stat: { size: number; mtimeMs: number }) {
	const relative = path.relative(workspace, file).replaceAll(path.sep, "/");
	const key = await fileInside(workspace, "export-profiles", filename(relative)).catch(() => null);
	const profile = key ? await readJson(key).catch(() => null) : null;
	if (profile?.projectId === projectId && profile.file === relative && profile.bytes === stat.size && profile.mtimeMs === stat.mtimeMs) {
		return { width: Number(profile.width), height: Number(profile.height), fps: Number(profile.fps), ...exportSceneSettings(profile) };
	}
	return null;
}
