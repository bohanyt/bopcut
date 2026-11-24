import { readdir } from "node:fs/promises";
import path from "node:path";
import { projectDir, readJson } from "@/services/storage/server/files";
import { migrateProject } from "@/services/storage/project-migration";
import { isRecord } from "@/services/storage/migrations/transformers/utils";
import type { SerializedProject } from "@/services/storage/types";
import { calculateTotalDuration, type TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { fileInside } from "./inside";
import { getRootScene } from "./scene-graph";
import { packTranscript, sourceTranscript, timelineTranscript, type TranscriptMedia } from "./packed-transcript";

function transcriptScenes(project: SerializedProject): TScene[] {
	const malformed = (field: string) => new Error(`The saved project has invalid ${field}. Open it in the editor and save it again.`);
	if (!Array.isArray(project.scenes)) throw malformed("scenes");
	return project.scenes.map((scene) => {
		if (!scene || typeof scene.id !== "string" || !scene.tracks || !Array.isArray(scene.tracks.overlay) ||
			!Array.isArray(scene.tracks.audio)) throw malformed("scene tracks");
		for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
			if (!track || !Array.isArray(track.elements)) throw malformed("track elements");
			for (const element of track.elements) {
				if (!element || typeof element.id !== "string" || typeof element.name !== "string" || typeof element.type !== "string" ||
					!Number.isSafeInteger(element.startTime) || !Number.isSafeInteger(element.duration) || element.duration < 0) {
					throw malformed("clip timing or identity");
				}
				if (element.type !== "audio" && element.type !== "video" && element.type !== "compound") continue;
				if (!Number.isSafeInteger(element.trimStart) || element.trimStart < 0) throw malformed("clip trim");
				if (element.type === "compound" && typeof element.sceneId !== "string") throw malformed("compound scene reference");
				// External writers may omit the parameter bag when they leave every parameter at its default.
				if (element.params == null) element.params = {};
				if (!isRecord(element.params)) throw malformed("clip parameters");
			}
		}
		return { ...scene, createdAt: new Date(scene.createdAt), updatedAt: new Date(scene.updatedAt) };
	});
}

export async function readReviewableProject(projectId: string, signal: AbortSignal, { includeStaged = true, timeline = true } = {}) {
	const dir = projectDir(projectId);
	const projectFile = await fileInside(path.dirname(dir), projectId, "project.json");
	if (!projectFile) throw new Error("Project was not found on disk.");
	const stored: unknown = await readJson(projectFile);
	if (!isRecord(stored) || !isRecord(stored.metadata) || stored.metadata.id !== projectId || typeof stored.version !== "number") {
		throw new Error("The saved project is missing its identity or version.");
	}
	const project = await migrateProject(stored, projectId, stored.version);
	const navigation = await fileInside(dir, "navigation.json");
	const saved = navigation ? await readJson(navigation).catch(() => null) : null;
	const metadata = path.join(dir, "media", "_metadata");
	const files = await readdir(metadata).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const media: (TranscriptMedia & { diskFile?: string; width?: number; height?: number; fileType?: string })[] = [];
	for (const file of files.sort()) {
		signal.throwIfAborted();
		if (!/^[\w-]{1,128}\.json$/.test(file)) continue;
		const safe = await fileInside(dir, "media", "_metadata", file);
		const record = safe && await readJson(safe);
		if (record && typeof record.name === "string" && (!record.staged || includeStaged)) {
			media.push({
				id: file.slice(0, -5), name: record.name,
				duration: Number.isFinite(record.duration) && record.duration >= 0 ? record.duration : undefined,
				hasAudio: typeof record.hasAudio === "boolean" ? record.hasAudio : undefined,
				words: record.words,
				diskFile: typeof record.diskFile === "string" ? record.diskFile : undefined,
				fileType: typeof record.fileType === "string" ? record.fileType : undefined,
					width: typeof record.width === "number" ? record.width : undefined,
				height: typeof record.height === "number" ? record.height : undefined,
			});
		}
	}
	const scenes = timeline ? transcriptScenes(project) : [];
	const active = typeof saved?.currentSceneId === "string" && scenes.some((scene) => scene.id === saved.currentSceneId)
		? saved.currentSceneId : project.currentSceneId ?? null;
	return { project, projectFile, dir, root: getRootScene(scenes, active), scenes, media };
}

export async function readTranscriptView(projectId: string, name: string | null, signal: AbortSignal): Promise<string> {
	const { root, scenes, media } = await readReviewableProject(projectId, signal, { includeStaged: name === null, timeline: name === null });
	if (name !== null) {
		const exact = media.find((asset) => asset.id === name);
		const matches = exact ? [exact] : media.filter((asset) => asset.name === name);
		if (matches.length !== 1) throw new Error(matches.length
			? `More than one media file has this name. Use a media ID: ${matches.map((asset) => asset.id).join(", ")}.`
			: "No project media matches this name or media ID.");
		const asset = matches[0];
		const clip = sourceTranscript(asset, media.some((other) => other.id !== asset.id && other.name === asset.name));
		return packTranscript([clip], "source", clip.end);
	}
	if (!root) throw new Error("No timeline was saved for this project.");
	return packTranscript(timelineTranscript(root, scenes, media), "timeline",
		calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND);
}
