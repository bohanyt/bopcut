import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type { ProjectNavigation, ProjectSummary, SerializedProject } from "../types";
import { isRecord } from "../migrations/transformers/utils";
import { atomicWrite, projectDir, readJson, retryTransient, revision, statFile, withProjectLock } from "./files";

export const projectFile = (id: string) => path.join(projectDir(id), "project.json");
const summaryFile = (id: string) => path.join(projectDir(id), "summary.json");
const navigationFile = (id: string) => path.join(projectDir(id), "navigation.json");
const thumbnailFile = (id: string) => path.join(projectDir(id), "thumbnail");
const thumbnailUrl = (id: string) => `/api/storage/projects/${id}/thumbnail`;

function inlineThumbnail(value: unknown) {
	return typeof value === "string"
		? /^data:(image\/(?:png|jpeg|webp));base64,/.exec(value)
		: null;
}

function storedThumbnail(value: unknown): string | undefined {
	if (typeof value !== "string" || /^data:/i.test(value) || value.startsWith("/api/storage/projects/")) return;
	return value;
}

async function preserveInlineThumbnail(id: string, thumbnail: string | undefined) {
	const inline = inlineThumbnail(thumbnail);
	if (!inline || !thumbnail || await statFile(thumbnailFile(id))) return;
	await atomicWrite(thumbnailFile(id), Buffer.from(thumbnail.slice(inline[0].length), "base64"));
}

function summarize(id: string, project: SerializedProject | null): ProjectSummary | null {
	if (project?.metadata?.id !== id || typeof project.metadata.name !== "string") return null;
	const { name, duration, createdAt, updatedAt, thumbnail } = project.metadata;
	return {
		version: project.version,
		metadata: {
			id, name, duration: Number.isFinite(duration) ? duration : legacyDuration(project), createdAt, updatedAt,
			thumbnail: inlineThumbnail(thumbnail) ? thumbnailUrl(id) : storedThumbnail(thumbnail),
		},
	};
}

function legacyDuration(project: SerializedProject): number {
	const scenes = Array.isArray(project.scenes) ? project.scenes.filter(isRecord) : [];
	const tracks = (scenes.find((scene) => scene.isMain) ?? scenes[0])?.tracks;
	if (!isRecord(tracks)) return 0;
	const ordered: unknown[] = Array.isArray(tracks.overlay) && Array.isArray(tracks.audio)
		? [tracks.main, ...tracks.overlay, ...tracks.audio]
		: Object.values(tracks);
	let duration = 0;
	for (const track of ordered) {
		if (!isRecord(track) || !Array.isArray(track.elements)) continue;
		for (const element of track.elements) {
			if (!isRecord(element) || typeof element.startTime !== "number" || typeof element.duration !== "number") continue;
			const end = element.startTime + element.duration;
			if (Number.isFinite(end)) duration = Math.max(duration, end);
		}
	}
	return duration;
}

/** Check the saved timeline under the same lock as project writes. */
export async function projectUsesMedia(id: string, mediaId: string): Promise<boolean> {
	const project: unknown = await readJson(projectFile(id));
	if (!isRecord(project)) return false;
	const scenes = Array.isArray(project.scenes) ? project.scenes : [project];
	return scenes.some((scene) => {
		if (!isRecord(scene) || !isRecord(scene.tracks)) return false;
		return Object.values(scene.tracks).flat().some((track) =>
			isRecord(track) && Array.isArray(track.elements) &&
			track.elements.some((element) => isRecord(element) && element.mediaId === mediaId),
		);
	});
}

function stamp(stat: Stats) {
	return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;
}

type SummaryCache = { stamp: string; summary: ProjectSummary | null };

async function cacheSummary(id: string, stat: Stats, summary: ProjectSummary | null) {
	try {
		await atomicWrite(summaryFile(id), JSON.stringify({ stamp: stamp(stat), summary }));
	} catch (error) {
		// The project is authoritative. Recover a missing or stale summary on the next listing.
		console.error(`Could not cache project summary (${id}):`, error);
	}
}

export async function readProjectSummary(id: string): Promise<ProjectSummary | null> {
	const stat = await statFile(projectFile(id));
	if (!stat) return null;
	const cached: SummaryCache | null = await readJson(summaryFile(id)).catch(() => null);
	const summary = cached?.stamp === stamp(stat)
		? cached.summary
		: await withProjectLock(id, async () => {
			const current = await statFile(projectFile(id));
			if (!current) return null;
			const fresh: SummaryCache | null = await readJson(summaryFile(id)).catch(() => null);
			if (fresh?.stamp === stamp(current)) return fresh.summary;
			const project: SerializedProject | null = await readJson(projectFile(id));
			const summary = summarize(id, project);
			await preserveInlineThumbnail(id, project?.metadata?.thumbnail);
			await cacheSummary(id, current, summary);
			return summary;
		});
	if (!summary) return null;
	if (await statFile(thumbnailFile(id))) summary.metadata.thumbnail = thumbnailUrl(id);
	return summary;
}

export async function readProject(id: string) {
	const project: SerializedProject | null = await readJson(projectFile(id));
	if (!project) return null;
	const [navigation, thumbnail] = await Promise.all([
		readJson(navigationFile(id)).catch((error) => {
			console.error(`Unreadable project navigation (${id}):`, error);
			return null;
		}),
		statFile(thumbnailFile(id)),
	]);
	const { metadata } = project;
	return {
		etag: revision(project),
		value: {
			...project,
			navigation: navigation ?? undefined,
			metadata: metadata && {
				...metadata,
				thumbnail: thumbnail || inlineThumbnail(metadata.thumbnail)
					? thumbnailUrl(id)
					: storedThumbnail(metadata.thumbnail),
			},
		},
	};
}

/** The caller holds the project lock. Preserve an old thumbnail before removing its inline bytes. */
export async function writeProject(id: string, value: SerializedProject, current: SerializedProject | null) {
	const legacyThumbnail = inlineThumbnail(value.metadata.thumbnail)
		? value.metadata.thumbnail
		: current?.metadata?.thumbnail;
	await preserveInlineThumbnail(id, legacyThumbnail);
	const { navigation: _navigation, ...project } = value;
	project.metadata.thumbnail = storedThumbnail(value.metadata.thumbnail);
	// Preserve inline view state written by older versions until it is superseded by navigation.json.
	project.timelineViewState ??= current?.timelineViewState;
	await atomicWrite(projectFile(id), JSON.stringify(project));
	const stat = await statFile(projectFile(id)).catch((error) => {
		console.error(`Could not check project summary (${id}):`, error);
		return null;
	});
	if (stat) await cacheSummary(id, stat, summarize(id, project));
	return revision(project);
}

export async function writeProjectNavigation(id: string, value: ProjectNavigation) {
	const file = navigationFile(id);
	const current: ProjectNavigation | null = await readJson(file);
	const view = value?.timelineViewState;
	if (
		typeof value?.currentSceneId !== "string" ||
		(view !== undefined && (
			!Number.isFinite(view?.zoomLevel) || !Number.isFinite(view?.scrollLeft) || !Number.isFinite(view?.playheadTime)
		))
	) return new Response(null, { status: 400 });

	const navigation = {
		currentSceneId: value.currentSceneId,
		...(view && { timelineViewState: { zoomLevel: view.zoomLevel, scrollLeft: view.scrollLeft, playheadTime: view.playheadTime } }),
	};
	const serialized = JSON.stringify(navigation);
	if (serialized !== JSON.stringify(current)) await atomicWrite(file, serialized);
	return new Response(null, { status: 204 });
}

function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
	const header = Buffer.from(bytes.subarray(0, 12));
	if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return null;
}

export async function writeProjectThumbnail(id: string, bytes: Uint8Array) {
	if (!imageType(bytes)) return new Response(null, { status: 400 });
	const file = thumbnailFile(id);
	await atomicWrite(file, bytes);
	const stat = await statFile(file);
	return new Response(null, { status: 204, headers: stat ? { ETag: `"${stamp(stat)}"` } : undefined });
}

export async function readProjectThumbnail(id: string, ifNoneMatch: string | null) {
	const file = thumbnailFile(id);
	const stat = await statFile(file);
	let bytes: Buffer<ArrayBuffer>;
	let etag: string;
	if (stat) {
		etag = `"${stamp(stat)}"`;
		if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
		bytes = await retryTransient(() => fs.readFile(file));
	} else {
		const project: SerializedProject | null = await readJson(projectFile(id));
		const thumbnail = project?.metadata?.thumbnail;
		const match = inlineThumbnail(thumbnail);
		if (!thumbnail || !match) return new Response(null, { status: 404 });
		etag = `"${revision(thumbnail)}"`;
		if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
		bytes = Buffer.from(thumbnail.slice(match[0].length), "base64");
	}
	const type = imageType(bytes);
	if (!type) return new Response(null, { status: 404 });
	return new Response(bytes, {
		headers: { "Content-Type": type, "Cache-Control": "no-cache", ETag: etag },
	});
}
