import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { MoveElementCommand, SplitElementsCommand, ToggleSourceAudioSeparationCommand } = await import("@/commands/timeline");
const { collectAudibleCandidates } = await import("@/media/audio");

const CLIP = { trackId: "t-main", elementId: "bg" } as const;
const assets = [{ id: "media-bg", name: "bg", type: "video" as const, hasAudio: true, file: new File([], "bg.mp4") }];

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes: TScene[] = fixture();
	getHost(scenes).tracks.main.elements = [video("bg", 0, 10)];
	getHost(scenes).tracks.audio = [];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: assets as never });
	return editor;
}

const tracks = () => EditorCore.getInstance().scenes.getActiveScene().tracks;
const separated = () => tracks().audio.flatMap((track) => track.elements.map((element) => ({ trackId: track.id, element })))
	.filter(({ element }) => element.type === "audio" && element.sourceType === "upload" && element.mediaId === "media-bg");
/** What plays: the video's own sound and every clip of its audio. */
const sounding = () => collectAudibleCandidates({ tracks: tracks(), mediaAssets: assets }).map(({ element }) => element.type);
const run = (command: InstanceType<typeof ToggleSourceAudioSeparationCommand | typeof SplitElementsCommand | typeof MoveElementCommand>) =>
	EditorCore.getInstance().command.execute({ command });

afterEach(() => EditorCore.reset());

describe("Recover audio after Extract audio", () => {
	test("the separated clip goes, so the sound plays once", () => {
		setup();
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		expect(sounding()).toEqual(["audio"]);
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		expect(separated()).toEqual([]);
		expect(sounding()).toEqual(["video"]);
	});

	test("pieces of a split separated clip that are still in sync go too", () => {
		setup();
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		const [{ trackId, element }] = separated();
		run(new SplitElementsCommand({ elements: [{ trackId, elementId: element.id }], splitTime: t(4) }));
		expect(separated()).toHaveLength(2);
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		expect(sounding()).toEqual(["video"]);
	});

	test("a separated clip moved elsewhere stays: it no longer doubles the video", () => {
		setup();
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		const [{ trackId, element }] = separated();
		run(new MoveElementCommand({ moves: [{ sourceTrackId: trackId, targetTrackId: trackId, elementId: element.id, newStartTime: t(3) }] }));
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		expect(separated().map(({ element }) => element.id)).toEqual([element.id]);
	});

	test("one Undo brings the separated clip back and keeps the video's sound off", () => {
		setup();
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		run(new ToggleSourceAudioSeparationCommand(CLIP));
		EditorCore.getInstance().command.undo();
		expect(separated()).toHaveLength(1);
		expect(sounding()).toEqual(["audio"]);
	});
});
