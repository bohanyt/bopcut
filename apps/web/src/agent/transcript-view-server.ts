import { readdir } from "node:fs/promises";
import path from "node:path";
import { projectDir, readJson } from "@/services/storage/server/files";
import type { SerializedProject } from "@/services/storage/types";
import { calculateTotalDuration, type TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { fileInside } from "./inside";
import { getRootScene } from "./scene-graph";
import { packTranscript, sourceTranscript, timelineTranscript, type TranscriptMedia } from "./packed-transcript";

export async function readTranscriptView(projectId: string, name: string | null, signal: AbortSignal): Promise<string> {
	const dir = projectDir(projectId);
	const projectFile = await fileInside(path.dirname(dir), projectId, "project.json");
	if (!projectFile) throw new Error("Project was not found on disk.");
	const project: SerializedProject = await readJson(projectFile);
	const navigation = await fileInside(dir, "navigation.json");
	const saved = navigation ? await readJson(navigation) : null;
	const scenes: TScene[] = project.scenes.map((scene) => ({
		...scene, createdAt: new Date(scene.createdAt), updatedAt: new Date(scene.updatedAt),
	}));
	const root = getRootScene(scenes, saved?.currentSceneId ?? project.currentSceneId ?? null);
	const metadata = path.join(dir, "media", "_metadata");
	const files = await readdir(metadata).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const media: TranscriptMedia[] = [];
	for (const file of files.sort()) {
		signal.throwIfAborted();
		if (!/^[\w-]{1,128}\.json$/.test(file)) continue;
		const safe = await fileInside(dir, "media", "_metadata", file);
		const record = safe && await readJson(safe);
		if (record && typeof record.name === "string" && (!record.staged || name === null)) {
			media.push({ ...record, id: file.slice(0, -5) });
		}
	}
	if (name !== null) {
		const exact = media.find((asset) => asset.id === name);
		const matches = exact ? [exact] : media.filter((asset) => asset.name === name);
		if (matches.length !== 1) throw new Error(matches.length
			? "More than one media file has this name. Use its media ID."
			: "No project media matches this name or media ID.");
		const clip = sourceTranscript(matches[0]);
		return packTranscript([clip], "source", clip.end);
	}
	if (!root) throw new Error("No timeline was saved for this project.");
	return packTranscript(timelineTranscript(root, scenes, media), "timeline",
		calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND);
}
