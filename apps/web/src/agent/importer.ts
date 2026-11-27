import { getBrowserTranslator } from "@/i18n/browser";
// Import an agent bundle (AGENT_WORKSPACE/bundle/bundle.json) as a normal OpenCut project.
// All elements remain native OpenCut elements and can be moved, trimmed, or deleted as usual.
// An element with `compound:{main?,overlay?,audio?,elements?}` becomes a compound clip whose
// nested tracks are built the same way (times relative to the clip's content).
import { EditorCore } from "@/core";
import type { AudioTrack, OverlayTrack, SceneTracks, TScene, VideoTrack } from "@/timeline";
import { relocateVisualCompounds, syncCompoundDurations } from "@/timeline/compound";
import { loadIcon } from "@/stickers/providers/iconify";
import { generateUUID } from "@/utils/id";
import { floatToFrameRate } from "@/fps/utils";
import { releaseMediaAssetUrls } from "@/media/url-release";
import { buildNewProject } from "@/project/create";
import { isProjectMode, type TProjectSettings } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import { type AgentAsset, type AgentElement, type LoadedMedia, buildAgentElement, checkAgentDuration, checkAgentTrim, createAgentTrack, prepareBundleAsset } from "./elements";
import { type BuildContext, applyAgentKeyframes, buildAgentCompound, walkAgentElements } from "./compound-content";
import { loadTextPresets } from "@/text/presets";
import { checkAgentCaption, resolveCaptionPreset } from "./captions";
import { BUNDLE_REV_HEADER } from "./inbox-types";

export type Bundle = {
	name: string; width: number; height: number;
	/** Project frame rate (frames per second); the editor default when omitted. Imported media never change it. */
	fps?: number;
	/** What the project is for (AGENT.md, *Work modes*); left unset when omitted or unknown. */
	mode?: string;
	assets: (AgentAsset & { key: string })[];
	main: AgentElement[]; audio: AgentElement[];
	overlay: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
};

/** Project settings a bundle asks for: its canvas size (custom) and, when given, its frame rate. */
export function bundleProjectSettings(bundle: Pick<Bundle, "width" | "height" | "fps">): Partial<TProjectSettings> | null {
	const settings: Partial<TProjectSettings> = {};
	const size = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 16 && n <= 8192;
	if (size(bundle.width) && size(bundle.height)) {
		settings.canvasSize = { width: bundle.width, height: bundle.height };
		settings.canvasSizeMode = "custom";
	}
	if (typeof bundle.fps === "number" && Number.isFinite(bundle.fps) && bundle.fps >= 1 && bundle.fps <= 240) {
		const rate = floatToFrameRate(bundle.fps);
		if (rate.numerator > 0 && rate.denominator > 0) settings.fps = rate;
	}
	return Object.keys(settings).length ? settings : null;
}

export function checkBundleAssetKeys(bundle: Pick<Bundle, "assets">): void {
	const seen = new Set<string>();
	for (const a of bundle.assets ?? []) {
		if (seen.has(a.key)) throw new Error(`Duplicate asset key: ${a.key}`);
		seen.add(a.key);
	}
}

/** Root tracks and nested compound scenes of a bundle (pure, given its loaded media). */
export function buildBundleScenes({ bundle, media, sceneId }: { bundle: Bundle; media: Map<string, LoadedMedia>; sceneId: string }): { tracks: SceneTracks; scenes: TScene[] } {
	const ctx: BuildContext = {
		canvas: { width: bundle.width, height: bundle.height }, keyframes: [], created: [], existing: [],
		mediaFor: (e) => (typeof e.asset === "string" ? media.get(e.asset) : undefined),
	};
	const build = (e: AgentElement, trackId: string, allowed: "video" | "audio" | null) => {
		if (!e.compound) return buildAgentElement({ e, media: ctx.mediaFor(e), trackId, sceneId, canvas: ctx.canvas, keyframes: ctx.keyframes });
		if (!allowed) throw new Error(`compound clip ${e.name} must be on the main, a video overlay, or the audio track`);
		return buildAgentCompound({ e, hostSceneId: sceneId, ctx });
	};
	const overlayAllows = (type: Bundle["overlay"][number]["type"]) => (type === "video" ? "video" : null);
	const mainId = generateUUID();
	const audioId = generateUUID();
	const tracks: SceneTracks = {
		main: { id: mainId, name: "Main", type: "video", muted: false, hidden: false, elements: (bundle.main ?? []).map((e) => build(e, mainId, "video")) } as VideoTrack,
		overlay: (bundle.overlay ?? []).map((t) => {
			// A compound's own audio plays only on an unmuted track.
			const track = createAgentTrack(t.type, t.name, { muted: !(t.elements ?? []).some((e) => e.compound) });
			track.elements = (t.elements ?? []).map((e) => build(e, track.id, overlayAllows(t.type)));
			return track;
		}) as OverlayTrack[],
		audio: [{ id: audioId, name: "Audio", type: "audio", muted: false, elements: (bundle.audio ?? []).map((e) => build(e, audioId, "audio")) } as AudioTrack],
	};
	const scenes = applyAgentKeyframes({ scenes: ctx.created, keyframes: ctx.keyframes, defaultSceneId: sceneId });
	const [host] = applyAgentKeyframes({ scenes: [{ id: sceneId, tracks } as TScene], keyframes: ctx.keyframes, defaultSceneId: sceneId });
	return { tracks: host.tracks, scenes };
}

/** The project exists either way: if the record fails, the home page only keeps offering the bundle. */
async function recordImport(rev: string, projectId: string) {
	try {
		const response = await fetch("/api/agent/bundle-imported", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev, projectId }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		console.warn("Could not record the bundle import", error);
	}
}

export async function importAgentBundle({ onStatus }: { onStatus: (text: string) => void }): Promise<string> {
	const signal = EditorCore.getInstance().project.getSessionSignal();
	const response = await fetch("/api/agent/bundle", { cache: "no-store" });
	const bundle: Bundle = await response.json();
	if (!response.ok) throw new Error((bundle as { error?: string })?.error ?? `HTTP ${response.status}`);
	// The version read, so the home page stops offering this bundle once it is a project.
	const rev = response.headers.get(BUNDLE_REV_HEADER);
	// Captions, trims, durations and asset keys are checked first: a bad bundle fails before a project is created.
	let presets: ReturnType<typeof loadTextPresets> | undefined;
	for (const e of walkAgentElements([...(bundle.main ?? []), ...(bundle.audio ?? []), ...(bundle.overlay ?? []).flatMap((t) => t.elements ?? [])])) {
		if (e.caption?.preset) e.caption = resolveCaptionPreset(e.caption, await (presets ??= loadTextPresets()));
		checkAgentCaption(e);
		checkAgentTrim(e);
		checkAgentDuration(e);
	}
	checkBundleAssetKeys(bundle);
	const project = buildNewProject({ name: bundle.name, mode: isProjectMode(bundle.mode) ? bundle.mode : undefined });
	const projectId = project.metadata.id;
	const settings = { ...project.settings, ...bundleProjectSettings(bundle) };
	const media = new Map<string, LoadedMedia>();
	let storageTouched = false;
	try {
		for (const [index, asset] of bundle.assets.entries()) {
			onStatus(getBrowserTranslator()("agentImport.asset", { done: index + 1, total: bundle.assets.length, name: asset.name }));
			const { mediaAsset, loaded } = await prepareBundleAsset({ asset, signal });
			try {
				signal.throwIfAborted();
				storageTouched = true;
				await storageService.saveMediaAsset({ projectId, mediaAsset });
				media.set(asset.key, loaded);
			} finally {
				releaseMediaAssetUrls(mediaAsset);
			}
		}
		for (const e of walkAgentElements([...(bundle.main ?? []), ...(bundle.audio ?? []), ...(bundle.overlay ?? []).flatMap((t) => t.elements ?? [])])) {
			signal.throwIfAborted();
			if (e.icon) e.icon.svg = await loadIcon(e.icon.name);
		}
		signal.throwIfAborted();
		onStatus(getBrowserTranslator()("agentImport.timeline"));
		const [main] = project.scenes;
		const built = buildBundleScenes({ bundle: { ...bundle, ...settings.canvasSize }, media, sceneId: main.id });
		const scenes = syncCompoundDurations(relocateVisualCompounds([{ ...main, tracks: built.tracks }, ...built.scenes]));
		storageTouched = true;
		await storageService.saveProject({ project: {
			...project,
			settings,
			scenes,
			metadata: { ...project.metadata, duration: getProjectDurationFromScenes({ scenes }), updatedAt: new Date() },
		} });
	} catch (error) {
		if (storageTouched) {
			try {
				await storageService.deleteProject({ id: projectId });
			} catch (cleanupError) {
				const message = (value: unknown) => value instanceof Error ? value.message : String(value);
				throw new Error(getBrowserTranslator()("agentImport.cleanupFailed", {
					error: message(error), cleanup: message(cleanupError),
				}), { cause: error });
			}
		}
		throw error;
	}
	if (rev) await recordImport(rev, projectId);
	onStatus(getBrowserTranslator()("agentImport.done", { count: bundle.assets.length }));
	return projectId;
}
