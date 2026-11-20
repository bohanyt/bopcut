// Agent elements (bundle/draft) -> native OpenCut timeline elements.
import { checkPresetParams } from "@/animation/presets";
import { animateAgentElement } from "./animate";
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildEffectElement, buildGraphicElement, buildTextElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { getGraphicDefinition } from "@/graphics";
import type { ParamValues } from "@/params";
import { generateUUID } from "@/utils/id";
import type { SfxFile, SfxSource } from "@/sounds/sfx-types";
import type { MusicFile, MusicSource } from "@/sounds/music-types";
import { buildAgentCaption, type AgentCaption } from "./captions";
import { parseSourceWords, type SourceWord } from "@/media/words";

/**
 * A file under AGENT_FILES_ROOT (`path`), a section of an online video (`url` + `start`/`end` or `duration`,
 * fetched with POST /api/agent/retrieve into `retrieved/`; `audioOnly` keeps only the sound), or a sound
 * effect found by name (`sfx`, best match in the library folders and myinstants, or only `sfxSources`).
 */
export type AgentAsset = {
	path?: string; url?: string; start?: number | string; end?: number | string; duration?: number | string;
	height?: number; audioOnly?: boolean; sfx?: string; sfxSources?: SfxSource[];
	/** A song by name (best match in the music folders, then online), or only `musicSources`. */
	music?: string; musicSources?: MusicSource[];
	type: "image" | "video" | "audio" | "model"; name: string;
	/** Spoken words of the file (source seconds), kept with the media for cuts that never chop a word. */
	words?: SourceWord[];
};
/** Time in seconds relative to the element; `interpolation` of the segment that starts at this key. */
export type AgentKeyframe = { path: string; time: number; value: number | string; interpolation?: "linear" | "hold" | "bezier" };
export type AgentElement = {
	agent_id?: string; name: string; start: number; duration: number; trimStart?: number;
	/** Video only: play the video's own sound (off by default). */
	sourceAudio?: boolean;
	asset?: string | AgentAsset;
	/** An existing media id of the project, used instead of `asset` (nothing is imported). */
	mediaId?: string;
	/** `"words"`: a start or end inside a spoken word of the media moves out of it (see word-cuts). */
	cut?: "words";
	/** Starts the clip where this word of its media starts / ends it where this word ends (see word-cuts). */
	startAtWord?: import("@/timeline/word-cuts").WordRef; endAfterWord?: import("@/timeline/word-cuts").WordRef;
	model3d?: { params?: Record<string, number> }; effect?: string; effectParams?: Record<string, number>;
	graphic?: { definitionId: string; params?: ParamValues }; icon?: { name: string; color?: string; svg?: string }; text?: string; group?: string;
	params?: ParamValues; size?: [number, number];
	caption?: AgentCaption;
	keyframes?: AgentKeyframe[];
	/** In and out animation presets (see agent/animate). */
	animate?: import("./animate").AgentAnimate;
	/** Makes this element a compound clip holding these nested tracks (times relative to the clip's content). */
	compound?: AgentCompoundContent;
};
export type AgentTrackType = "video" | "audio" | "effect" | "graphic" | "text";
/** Where an element goes: a track by name (Main/Utama alias), created at `index` (0 = topmost overlay) if missing. */
export type AgentTrackRef = { name: string; type?: AgentTrackType; index?: number; id?: string };
/**
 * Nested tracks of a compound clip, bundle style (`main`, `overlay` with index 0 = topmost, `audio`)
 * and/or draft style (`elements`, each with its own `track`, placed like a draft `add`).
 */
export type AgentCompoundContent = {
	main?: AgentElement[];
	overlay?: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
	audio?: AgentElement[];
	elements?: (AgentElement & { track: AgentTrackRef })[];
};
export type LoadedMedia = { id: string; type: AgentAsset["type"]; width?: number; height?: number; duration?: number; words?: SourceWord[]; retrieved?: RetrievedAsset; sfx?: SfxFile; music?: MusicFile };
/** What the retrieve endpoint fetched for a `url` asset: its file under AGENT_FILES_ROOT and its source. */
export type RetrievedAsset = { path: string; name: string; source: { link: string; title?: string; uploader?: string; start: number; end: number } };

/** Identity of an asset within one draft or bundle, so the same file or section is loaded once. */
export function assetKey(asset: AgentAsset): string {
	if (asset.path) return asset.path;
	if (asset.sfx !== undefined && !asset.url) return JSON.stringify(["sfx", asset.sfx, asset.sfxSources]);
	if (asset.music !== undefined && !asset.url) return JSON.stringify(["music", asset.music, asset.musicSources]);
	return JSON.stringify([asset.url, asset.start, asset.end, asset.duration, asset.height, asset.audioOnly]);
}

/** Find a song by name (best match) and save it under AGENT_FILES_ROOT. */
export async function findAgentMusic(asset: AgentAsset): Promise<MusicFile> {
	const res = await fetch("/api/agent/music", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ kind: "find", query: asset.music, ...(asset.musicSources ? { sources: asset.musicSources } : {}) }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Cannot find song "${asset.music}": ${body.error ?? res.status}`);
	return body as MusicFile;
}

/** Find a sound effect by name (best match) and save it under AGENT_FILES_ROOT. */
export async function findAgentSfx(asset: AgentAsset): Promise<SfxFile> {
	const res = await fetch("/api/agent/sfx", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ kind: "find", query: asset.sfx, ...(asset.sfxSources ? { sources: asset.sfxSources } : {}) }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Cannot find sound "${asset.sfx}": ${body.error ?? res.status}`);
	return body as SfxFile;
}

/** Fetch a `url` asset's section through the retrieve endpoint; returns where it was saved. */
export async function retrieveAgentAsset(asset: AgentAsset): Promise<RetrievedAsset> {
	const res = await fetch("/api/agent/retrieve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ kind: "section", url: asset.url, start: asset.start, end: asset.end, duration: asset.duration, height: asset.height, audioOnly: asset.audioOnly }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Cannot retrieve ${asset.url}: ${body.error ?? res.status}`);
	return body as RetrievedAsset;
}
/** Keyframe to add once the element is placed; time in seconds, relative to the element. */
export type PendingKeyframe = { sceneId?: string; trackId: string; elementId: string; propertyPath: string; time: number; value: number | string; interpolation?: AgentKeyframe["interpolation"] };

export const secs = (seconds: number) => mediaTimeFromSeconds({ seconds });

/**
 * Where an asset's file is and its processed media: a file from AGENT_FILES_ROOT, or, for a `url` asset,
 * the section the retrieve endpoint fetched first, or, for an `sfx`/`music` asset, the best match.
 */
async function readAgentAsset(asset: AgentAsset) {
	if (!asset.path && !asset.url && !asset.sfx?.trim() && !asset.music?.trim()) throw new Error(`Asset "${asset.name}" needs a path, a url, an sfx name or a music name`);
	const words = asset.words === undefined ? undefined : parseSourceWords(asset.words);
	if (words === null) throw new Error(`Asset "${asset.name}": words must be a list of {text, start, end} in seconds`);
	const retrieved = asset.path || !asset.url ? undefined : await retrieveAgentAsset(asset);
	const sfx = asset.path || asset.url || !asset.sfx?.trim() ? undefined : await findAgentSfx(asset);
	const music = asset.path || asset.url || sfx || !asset.music?.trim() ? undefined : await findAgentMusic(asset);
	const filePath = asset.path ?? retrieved?.path ?? sfx?.path ?? (music as MusicFile).path;
	const res = await fetch(`/api/agent/file?p=${encodeURIComponent(filePath)}`);
	if (!res.ok) throw new Error("Cannot read asset: " + filePath);
	const blob = await res.blob();
	const fileName = filePath.split("/").pop() ?? asset.name;
	const [processed] = await processMediaAssets({ files: [new File([blob], fileName, { type: blob.type })] });
	if (!processed) throw new Error("Failed to process asset: " + filePath);
	return { processed, filePath, name: asset.name || retrieved?.name || sfx?.name || music?.name || fileName, retrieved, sfx, music, words };
}

const loadedMedia = (asset: AgentAsset, id: string, read: Awaited<ReturnType<typeof readAgentAsset>>): LoadedMedia => ({
	id, type: asset.type === "model" ? "model" : read.processed.type as AgentAsset["type"], width: read.processed.width, height: read.processed.height, duration: read.processed.duration,
	...(read.words ? { words: read.words } : {}),
	...(read.retrieved ? { retrieved: read.retrieved } : {}),
	...(read.sfx ? { sfx: read.sfx } : {}),
	...(read.music ? { music: read.music } : {}),
});

/** Register an asset as media in the active project (bundle import). */
export async function loadAgentAsset({ projectId, asset }: { projectId: string; asset: AgentAsset }): Promise<LoadedMedia> {
	const read = await readAgentAsset(asset);
	// Agent imports never raise the project frame rate: the bundle (or the open project) decides it.
	const saved = await EditorCore.getInstance().media.addMediaAsset({ projectId, asset: { ...read.processed, name: read.name, ...(read.words ? { words: read.words } : {}) }, ratchetFps: false });
	if (!saved) throw new Error("Failed to save asset: " + read.filePath);
	return loadedMedia(asset, saved.id, read);
}

/**
 * Like loadAgentAsset, but the media stays private (staged) until the draft commits; `onId` gets
 * its id before it is written, so a failed or cancelled draft can always remove it.
 */
export async function stageAgentAsset({ projectId, asset, onId }: { projectId: string; asset: AgentAsset; onId: (id: string) => void }): Promise<LoadedMedia> {
	const read = await readAgentAsset(asset);
	try {
		const staged = await EditorCore.getInstance().media.stageMediaAsset({ projectId, asset: { ...read.processed, name: read.name, ...(read.words ? { words: read.words } : {}) }, onId });
		return loadedMedia(asset, staged.id, read);
	} catch (error) {
		throw new Error(`Failed to save asset: ${read.filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Media already in the project, for an element with `mediaId` (`model3d` elements use it as a model). */
export function existingAgentMedia(e: AgentElement): LoadedMedia {
	const asset = EditorCore.getInstance().media.getAssets().find((m) => m.id === e.mediaId);
	if (!asset) throw new Error(`Media not in project: ${e.mediaId}`);
	return { id: asset.id, type: e.model3d ? "model" : asset.type, width: asset.width, height: asset.height, duration: asset.duration, ...(asset.words ? { words: asset.words } : {}) };
}

/** Track type an element goes on when the draft or bundle does not say. */
export function inferTrackType(e: AgentElement, media?: LoadedMedia): AgentTrackType {
	if (e.caption) return "text";
	return media?.type === "audio" ? "audio" : e.effect ? "effect" : (e.graphic || e.icon) ? "graphic" : e.text !== undefined ? "text" : "video";
}

/** Empty agent track. Video tracks for footage are muted (source audio stays off); compound hosts pass muted: false. */
export function createAgentTrack(type: AgentTrackType, name: string, { muted = true }: { muted?: boolean } = {}): any {
	if (type === "audio") return { id: generateUUID(), name, type, muted: false, elements: [] };
	if (type === "effect") return { id: generateUUID(), name, type, hidden: false, elements: [] };
	if (type === "graphic" || type === "text") return { id: generateUUID(), name, type, hidden: false, elements: [] };
	return { id: generateUUID(), name, type, muted, hidden: false, elements: [] };
}

/**
 * Build an OpenCut element (not a compound clip; see buildAgentNode). Keyframes are collected in
 * `keyframes`, tagged with `sceneId` when given.
 */
export function buildAgentElement(args: {
	e: AgentElement; media?: LoadedMedia; trackId: string; sceneId?: string; canvas: { width: number; height: number }; keyframes: PendingKeyframe[];
}): any {
	const element = buildAgentElementOnly(args);
	// Animation presets written as raw params are checked like `animate`.
	checkPresetParams(element, args.e.params);
	return args.e.animate === undefined ? element : animateAgentElement(element, args.e.animate);
}

function buildAgentElementOnly({ e, media, trackId, sceneId, canvas, keyframes: collected }: {
	e: AgentElement; media?: LoadedMedia; trackId: string; sceneId?: string; canvas: { width: number; height: number }; keyframes: PendingKeyframe[];
}): any {
	const keyframes = { push: (k: PendingKeyframe) => collected.push(sceneId ? { ...k, sceneId } : k) };
	if (e.caption) return buildAgentCaption({ e, trackId, sceneId, canvas, keyframes: collected });
	if (e.effect) {
		const el: any = { ...buildEffectElement({ effectType: e.effect, startTime: secs(e.start), duration: secs(e.duration) }), id: generateUUID(), agentId: e.agent_id };
		el.name = e.name;
		el.params = { ...el.params, ...(e.effectParams ?? {}) };
		return el;
	}
	if (e.text !== undefined) {
		const el: any = { ...buildTextElement({ raw: { name: e.name, params: { content: e.text } }, startTime: secs(e.start) }), id: generateUUID(), agentId: e.agent_id, groupId: e.group, duration: secs(e.duration) };
		Object.assign(el.params, e.params ?? {});
		for (const k of e.keyframes ?? []) {
			const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
			for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, interpolation: k.interpolation, value: k.value });
		}
		return el;
	}
	if (e.icon) {
		if (!e.icon.svg) throw new Error("Icon not loaded: " + e.icon.name);
		e = { ...e, graphic: { definitionId: "icon", params: { iconName: e.icon.name, color: e.icon.color ?? "#ffffff", svg: e.icon.svg } } };
	}
	if (e.graphic) {
		const definition = getGraphicDefinition({ definitionId: e.graphic.definitionId });
		const el: any = { ...buildGraphicElement({ definitionId: e.graphic.definitionId, name: e.name, startTime: secs(e.start), params: e.graphic.params }), id: generateUUID(), agentId: e.agent_id, groupId: e.group, duration: secs(e.duration) };
		if (e.size) {
			const baseSize = Math.min(canvas.width, canvas.height);
			el.params["transform.scaleX"] = e.size[0] / baseSize;
			el.params["transform.scaleY"] = e.size[1] / baseSize;
		}
		Object.assign(el.params, e.params ?? {});
		for (const k of e.keyframes ?? []) {
			const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [definition.params.some((p) => p.key === k.path) ? `params.${k.path}` : k.path];
			for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, interpolation: k.interpolation, value: k.path === "scale" ? Number(k.value) * (el.params[propertyPath] as number) : k.value });
		}
		return el;
	}
	if (e.model3d && media?.type !== "model") throw new Error("Model asset missing for " + e.name);
	if (!media) throw new Error("Asset missing for " + e.name);
	const trimStart = e.trimStart ?? 0;
	// Without a duration, audio and video play to the end of the media (e.g. a sound effect found by name).
	const duration = typeof e.duration === "number" && e.duration > 0 ? e.duration : media.duration ? Math.max(0.01, media.duration - trimStart) : 5;
	const el: any = { ...buildElementFromMedia({ mediaId: media.id, mediaType: media.type === "model" ? "image" : media.type, name: e.name, duration: secs(duration), startTime: secs(e.start) }), id: generateUUID(), agentId: e.agent_id, groupId: e.group };
	if (e.model3d) Object.assign(el.params, e.model3d.params ?? {});
	if (media.type !== "image" && media.duration) {
		el.sourceDuration = secs(media.duration);
		el.trimStart = secs(trimStart);
		el.trimEnd = secs(Math.max(0, media.duration - trimStart - duration));
	}
	// A video's own sound is off unless asked for: clips usually bring their sound as separate audio elements.
	if (media.type === "video") el.isSourceAudioEnabled = e.sourceAudio === true;
	let base = 1;
	if (e.size && media.width && media.height) {
		const contain = Math.min(canvas.width / media.width, canvas.height / media.height);
		base = e.size[0] / (media.width * contain);
		el.params["transform.scaleX"] = base;
		el.params["transform.scaleY"] = base;
	}
	for (const [k, v] of Object.entries(e.params ?? {})) el.params[k] = v;
	for (const k of e.keyframes ?? []) {
		const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
		for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, interpolation: k.interpolation, value: k.path === "scale" ? Number(k.value) * base : k.value });
	}
	return el;
}
