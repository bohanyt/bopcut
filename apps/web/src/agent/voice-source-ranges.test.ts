import { afterEach, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, UploadAudioElement as AudioElement } from "@/timeline";
import type { TProject } from "@/project/types";
import { buildResizeMembers } from "@/timeline/controllers/resize-controller";
import { computeGroupResize } from "@/timeline/group-resize";
import type { ResizeSide } from "@/timeline/group-resize/types";
import { mediaTimeFromSeconds, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { storageService } = await import("@/services/storage/service");

/**
 * A voice-over cut from one long take, the way an agent should place it: every kept span is a clip
 * of the whole recording with its own `trimStart` and `duration`, never a new file of just that span.
 * The rest of the recording stays behind each clip, so a cut that is too tight can be dragged open.
 */
const TAKE = { path: "voice/take.wav", type: "audio", name: "take" } as const;
const TAKE_SECONDS = 40;
const fps = { numerator: 30, denominator: 1 };
const seconds = (time: MediaTime | undefined) => (time ?? 0) / TICKS_PER_SECOND;

function cutVoice(): TScene {
	const empty: TScene = {
		id: "main", name: "Main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { overlay: [], main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] },
	};
	const span = (agent_id: string, start: number, trimStart: number, duration: number) =>
		({ op: "add", track: { name: "VO", type: "audio" }, element: { agent_id, name: agent_id, asset: TAKE, start, duration, trimStart } }) as const;
	const { scenes, applied } = computeAgentDraft({
		scenes: [empty], rootSceneId: "main", canvas: { width: 1080, height: 1920 }, fps, ripple: false, atomic: true,
		mediaFor: () => ({ id: "m-take", type: "audio", duration: TAKE_SECONDS }),
		ops: [
			// Line 1, cut tight in the middle of the take.
			span("line-1", 10, 4.2, 2.5),
			// Line 2, made of two takes of the same recording, side by side.
			span("line-2a", 13, 11, 1.5),
			span("line-2b", 14.5, 19.3, 2),
			// Line 3, near the end of the recording.
			span("line-3", 30, 36, 3),
		],
	});
	expect(applied).toBe(true);
	return scenes[0];
}

const voiceTrack = (tracks: SceneTracks) => tracks.audio.find(({ name }) => name === "VO")!;
const clip = (tracks: SceneTracks, agentId: string) => voiceTrack(tracks).elements.find((element) => element.agentId === agentId) as AudioElement;
const span = (element: AudioElement) => ({
	start: seconds(element.startTime), duration: seconds(element.duration), trimStart: seconds(element.trimStart),
	trimEnd: seconds(element.trimEnd), source: seconds(element.sourceDuration),
});

function drag(tracks: SceneTracks, agentId: string, side: ResizeSide, by: number) {
	const target = clip(tracks, agentId);
	const members = buildResizeMembers({ tracks, selectedElements: [{ trackId: voiceTrack(tracks).id, elementId: target.id }] });
	const { updates } = computeGroupResize({ members, side, deltaTime: mediaTimeFromSeconds({ seconds: by }), fps });
	const patch = updates[0].patch;
	return { start: seconds(patch.startTime), duration: seconds(patch.duration), trimStart: seconds(patch.trimStart), trimEnd: seconds(patch.trimEnd) };
}

const realAdapter = (storageService as unknown as { projectsAdapter: unknown }).projectsAdapter;
afterEach(() => {
	(storageService as unknown as { projectsAdapter: unknown }).projectsAdapter = realAdapter;
});

/** Saves the project as JSON on a disk held in memory and opens it again. */
async function saveAndReopen(scene: TScene): Promise<TScene> {
	const disk = new Map<string, string>();
	(storageService as unknown as { projectsAdapter: unknown }).projectsAdapter = {
		set: async ({ key, value }: { key: string; value: unknown }) => void disk.set(key, JSON.stringify(value)),
		get: async (key: string) => (disk.has(key) ? JSON.parse(disk.get(key)!) : null),
		revisionOf: () => undefined,
	};
	const project = {
		metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
		scenes: [scene], currentSceneId: scene.id, version: CURRENT_PROJECT_VERSION,
		settings: { fps, canvasSize: { width: 1080, height: 1920 } },
	} as unknown as TProject;
	await storageService.saveProject({ project });
	const reopened = await storageService.loadProject({ id: "p", readOnly: true });
	return reopened!.project.scenes[0];
}

test("an agent's voice-over cut keeps every span on the whole recording, with the rest of it on both sides", () => {
	const { tracks } = cutVoice();
	const clips = voiceTrack(tracks).elements as AudioElement[];
	expect(clips).toHaveLength(4);
	// One media file for all of them: no span became a file of its own.
	expect(new Set(clips.map(({ mediaId }) => mediaId))).toEqual(new Set(["m-take"]));
	expect(span(clip(tracks, "line-1"))).toEqual({ start: 10, duration: 2.5, trimStart: 4.2, trimEnd: 33.3, source: 40 });
	expect(span(clip(tracks, "line-2b"))).toMatchObject({ trimStart: 19.3, trimEnd: 18.7, source: 40 });
});

test("a tight cut opens on the left and on the right, as far as the recording goes", () => {
	const { tracks } = cutVoice();
	// Half a second more before line 1: the breath before it plays again from the same recording.
	expect(drag(tracks, "line-1", "left", -0.5)).toEqual({ start: 9.5, duration: 3, trimStart: 3.7, trimEnd: 33.3 });
	// Dragged far to the left, it stops at the start of the recording (4.2 s of it are there).
	expect(drag(tracks, "line-1", "left", -8)).toMatchObject({ start: 5.8, duration: 6.7, trimStart: 0 });
	// The end of line 3 opens up to the end of the recording, and no further.
	expect(drag(tracks, "line-3", "right", 0.4)).toEqual({ start: 30, duration: 3.4, trimStart: 36, trimEnd: 0.6 });
	expect(drag(tracks, "line-3", "right", 5)).toMatchObject({ duration: 4, trimEnd: 0 });
	// Each span of a line made from two takes opens on its own outer side. At the seam between them,
	// one span bounds the other: shortening one makes room for the other to open.
	expect(drag(tracks, "line-2a", "left", -0.3)).toMatchObject({ start: 12.7, trimStart: 10.7 });
	expect(drag(tracks, "line-2b", "right", 0.5)).toMatchObject({ duration: 2.5, trimEnd: 18.2 });
	expect(drag(tracks, "line-2a", "right", 1)).toMatchObject({ duration: 1.5, trimEnd: 27.5 });
	expect(drag(tracks, "line-2a", "right", -0.4)).toMatchObject({ duration: 1.1, trimEnd: 27.9 });
});

test("after a save and reopen, the clips still play the whole recording and still open", async () => {
	const scene = cutVoice();
	const reopened = await saveAndReopen(scene);
	for (const agentId of ["line-1", "line-2a", "line-2b", "line-3"]) {
		expect(clip(reopened.tracks, agentId).mediaId).toBe("m-take");
		expect(span(clip(reopened.tracks, agentId))).toEqual(span(clip(scene.tracks, agentId)));
	}
	expect(drag(reopened.tracks, "line-1", "left", -0.5)).toMatchObject({ start: 9.5, trimStart: 3.7 });
	expect(drag(reopened.tracks, "line-3", "right", 5)).toMatchObject({ duration: 4, trimEnd: 0 });
});
