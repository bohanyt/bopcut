import { expect, mock, test } from "bun:test";
import type { NormalizedCubicBezier, ScalarAnimationKey } from "@/animation/types";
import { getScalarChannelValueAtTime } from "@/animation/interpolation";
import { fixture, getHost, rect, t, video } from "@/timeline/__tests__/compound-fixtures";
import { buildGraphEditorSegmentPatches, resolveGraphEditorSelectionState } from "@/timeline/components/graph-editor/session";
import type { TProject } from "@/project/types";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

const POP: NormalizedCubicBezier = [0.175, 0.885, 0.32, 1.275];

test("a curve on a red-to-yellow fill keeps red, blue and alpha constant and shows the curve as set", () => {
	const scenes = fixture();
	const box = rect("box", 0, 5);
	const scalar = (id: string, time: number, value: number): ScalarAnimationKey => ({
		id,
		time: t(time),
		value,
		segmentToNext: "linear",
		tangentMode: "auto",
	});
	box.animations = {
		"params.fill": {
			r: { keys: [scalar("c0", 0, 1), scalar("c1", 1, 1)] },
			g: { keys: [scalar("c0", 0, 0), scalar("c1", 1, 1)] },
			b: { keys: [scalar("c0", 0, 0), scalar("c1", 1, 0)] },
			a: { keys: [scalar("c0", 0, 1), scalar("c1", 1, 1)] },
		},
	} as never;
	getHost(scenes).tracks.overlay.find((track) => track.id === "t-gfx")!.elements = [box];

	const state = resolveGraphEditorSelectionState({
		tracks: scenes.find((scene) => scene.id === "main")!.tracks,
		selectedKeyframes: [{ trackId: "t-gfx", elementId: "box", propertyPath: "params.fill", keyframeId: "c0" }],
	});
	if (state.status !== "ready") throw new Error(`Expected graph editor ready, got ${state.status}`);

	const patches = buildGraphEditorSegmentPatches({ segment: state.segments[0], cubicBezier: POP });
	const flatBluePatch = patches.find(({ context }) => context.componentKey === "b");
	expect(flatBluePatch).toBeDefined();
	const flatBlueRight = flatBluePatch!.patch.rightHandle;
	expect(flatBlueRight?.dv ?? 0).toBe(0);

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

	editor.timeline.updateKeyframeCurves({
		keyframes: patches.map(({ context, keyframeId, patch }) => ({
			trackId: "t-gfx",
			elementId: "box",
			propertyPath: "params.fill",
			componentKey: context.componentKey,
			keyframeId,
			patch,
		})),
	});

	const boxElement = editor.scenes.getActiveScene().tracks.overlay
		.find((track) => track.id === "t-gfx")!.elements[0];
	const animations = boxElement.animations;
	const blueChannel = (animations?.["params.fill"] as { b: { keys: ScalarAnimationKey[] } }).b;
	const alphaChannel = (animations?.["params.fill"] as { a: { keys: ScalarAnimationKey[] } }).a;
	const mid = t(0.5);
	const blueAtMid = getScalarChannelValueAtTime({ channel: blueChannel, time: mid, fallbackValue: -1 });
	const alphaAtMid = getScalarChannelValueAtTime({ channel: alphaChannel, time: mid, fallbackValue: -1 });
	const redChannel = (animations?.["params.fill"] as { r: { keys: ScalarAnimationKey[] } }).r;
	expect(blueAtMid).toBeCloseTo(0, 5);
	expect(alphaAtMid).toBeCloseTo(1, 5);
	expect(getScalarChannelValueAtTime({ channel: redChannel, time: mid, fallbackValue: -1 })).toBeCloseTo(1, 5);

	// Reopened on the committed fill, the graph shows the curve that was set (read from green).
	const reopened = resolveGraphEditorSelectionState({
		tracks: editor.scenes.getActiveScene().tracks,
		selectedKeyframes: [{ trackId: "t-gfx", elementId: "box", propertyPath: "params.fill", keyframeId: "c0" }],
	});
	if (reopened.status !== "ready") throw new Error(`Expected graph editor ready, got ${reopened.status}`);
	reopened.segments[0].cubicBezier.forEach((value, index) => expect(value).toBeCloseTo(POP[index], 3));
	EditorCore.reset();
});
test("keyframes stacked at one time leave no segment for the graph editor, whatever its type", () => {
	const scenes = fixture();
	const clip = video("a", 0, 5);
	const keys: ScalarAnimationKey[] = [
		{ id: "low", time: t(0), value: 0.25, segmentToNext: "linear", tangentMode: "auto" },
		{ id: "high", time: t(0), value: 0.75, segmentToNext: "linear", tangentMode: "auto" },
	];
	clip.animations = { opacity: { keys } };
	getHost(scenes).tracks.main.elements = [clip];
	const state = resolveGraphEditorSelectionState({
		tracks: scenes.find((scene) => scene.id === "main")!.tracks,
		selectedKeyframes: [{ trackId: "t-main", elementId: "a", propertyPath: "opacity", keyframeId: "low" }],
	});
	expect(state).toMatchObject({ status: "unavailable", messageKey: "graph.sameTime" });
});
