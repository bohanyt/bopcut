import { describe, expect, mock, test } from "bun:test";
import type { AudioElement, TScene, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { allElements, allTracks, audio, getHost, scene, t, video } from "./compound-fixtures";

// Same GPU stubs as the other command tests (EditorCore pulls the renderer in).
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { buildSeparatedAudioElement } = await import("@/timeline/audio-separation");
const { buildAudioGainAutomation, hasAnimatedVolume, hasVolumeKeyframes } = await import("@/timeline/audio-state");

function setup() {
	const song = { ...audio("music", 0, 4), params: { volume: 0, fadeIn: 1, fadeOut: 0.5 } } as AudioElement;
	const scenes: TScene[] = [
		scene("main", {
			overlay: [],
			main: { id: "t-main", name: "Main Track", type: "video", muted: false, hidden: false, elements: [video("bg", 0, 10)] },
			audio: [{ id: "t-music", name: "Audio", type: "audio", muted: false, elements: [song] }],
		}),
	];
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({
		assets: ["media-bg", "media-music"].map((id) => ({ id, name: id, type: id === "media-bg" ? "video" : "audio" }) as unknown as MediaAsset),
	});
	return editor;
}

const musicParts = (editor: ReturnType<typeof setup>) =>
	allElements(allTracks(getHost(editor.scenes.getScenes()).tracks))
		.filter((e) => e.type === "audio")
		.sort((a, b) => a.startTime - b.startTime) as AudioElement[];

describe("fades when editing clips", () => {
	test("a split keeps the fade-in on the left part and the fade-out on the right part", () => {
		const editor = setup();
		editor.timeline.splitElements({ elements: [{ trackId: "t-music", elementId: "music" }], splitTime: t(2) });
		const [left, right] = musicParts(editor);
		expect(left.params.fadeIn).toBe(1);
		expect(left.params.fadeOut).toBe(0);
		expect(right.params.fadeIn).toBe(0);
		expect(right.params.fadeOut).toBe(0.5);
		editor.command.undo();
		expect(musicParts(editor).map((e) => [e.params.fadeIn, e.params.fadeOut])).toEqual([[1, 0.5]]);
	});

	test("keeping one side works like a trim: both fades stay", () => {
		const editor = setup();
		editor.timeline.splitElements({ elements: [{ trackId: "t-music", elementId: "music" }], splitTime: t(2), retainSide: "left" });
		const [left] = musicParts(editor);
		expect([left.params.fadeIn, left.params.fadeOut]).toEqual([1, 0.5]);
	});

	test("separating a video's sound keeps its fades", () => {
		const clip = { ...video("bg", 0, 10), params: { volume: -3, fadeIn: 0.4, fadeOut: 2 } } as unknown as VideoElement;
		const separated = buildSeparatedAudioElement({ sourceElement: clip });
		expect(separated.params).toMatchObject({ volume: -3, fadeIn: 0.4, fadeOut: 2 });
	});
});

describe("fade playback paths", () => {
	const clip = (params: Record<string, unknown>, seconds: number) =>
		({
			...audio("a", 0, seconds),
			duration: Math.round(seconds * TICKS_PER_SECOND) as MediaTime,
			params: { volume: 0, muted: false, ...params },
		}) as unknown as AudioElement;

	test("fades alone are animated volume but not volume keyframes", () => {
		const c = clip({ fadeIn: 0.5 }, 3);
		expect(hasAnimatedVolume({ element: c })).toBe(true);
		expect(hasVolumeKeyframes({ element: c })).toBe(false);
	});

	test("automation has a point exactly where each fade starts and ends", () => {
		const c = clip({ fadeIn: 0.05, fadeOut: 0.13 }, 1);
		const points = buildAudioGainAutomation({ element: c, fromLocalTime: 0, toLocalTime: 1, stepSeconds: 0.1 });
		const at = (s: number) => points.find((p) => Math.abs(p.localTime - s) < 1e-9);
		expect(at(0.05)?.gain).toBeCloseTo(1, 6);
		expect(at(0.87)?.gain).toBeCloseTo(1, 6);
		expect(points.map((p) => p.localTime)).toEqual([...points.map((p) => p.localTime)].sort((a, b) => a - b));
	});
});
