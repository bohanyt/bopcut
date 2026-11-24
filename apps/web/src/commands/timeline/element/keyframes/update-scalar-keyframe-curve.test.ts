import { expect, mock, test } from "bun:test";
import type { ScalarAnimationKey, ScalarCurveKeyframePatch } from "@/animation/types";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));

const { EditorCore } = await import("@/core");
const { UpdateScalarKeyframeCurveCommand } = await import("./update-scalar-keyframe-curve");

const cmdBase = { trackId: "t-main", elementId: "a", propertyPath: "opacity", componentKey: "value" } as const;
const bezierKeys: ScalarAnimationKey[] = [
	{ id: "first", time: t(1), value: 0, segmentToNext: "bezier", tangentMode: "broken", rightHandle: { dt: t(0.3), dv: 0.2 } },
	{ id: "second", time: t(2), value: 1, segmentToNext: "linear", tangentMode: "broken", leftHandle: { dt: t(-0.4), dv: -0.1 } },
];

function editor(keys: ScalarAnimationKey[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	getHost(scenes).tracks.main.elements = [{ ...video("a", 0, 5), animations: { opacity: { keys } } }];
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
		scenes, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
	} } as never);
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

const run = (ed: ReturnType<typeof editor>, keyframeId: string, patch: ScalarCurveKeyframePatch) => {
	ed.command.execute({ command: new UpdateScalarKeyframeCurveCommand({ ...cmdBase, keyframeId, patch }) });
};

test("same curve and 1e-12 handle: canUndo stays false and tracks keep identity", () => {
	for (const patch of [
		{ segmentToNext: "bezier" as const, rightHandle: { dt: t(0.3), dv: 0.2 } },
		{ segmentToNext: "bezier" as const, rightHandle: { dt: t(0.3), dv: 0.2 + 1e-12 } },
	]) {
		const ed = editor(bezierKeys);
		const tracksBefore = ed.scenes.getActiveScene().tracks;
		run(ed, "first", patch);
		expect(ed.command.canUndo()).toBe(false);
		expect(ed.scenes.getActiveScene().tracks).toBe(tracksBefore);
	}
});

test("handle changed by 0.01: one Undo step restores exactly", () => {
	const ed = editor(bezierKeys);
	const before = ed.scenes.getActiveScene().tracks.main.elements[0].animations;
	run(ed, "first", { segmentToNext: "bezier", rightHandle: { dt: t(0.3), dv: 0.21 } });
	expect(ed.command.canUndo()).toBe(true);
	ed.command.undo();
	expect(ed.scenes.getActiveScene().tracks.main.elements[0].animations).toEqual(before);
	expect(ed.command.canUndo()).toBe(false);
});

test("hold to linear: one step", () => {
	const ed = editor([
		{ id: "first", time: t(0), value: 0, segmentToNext: "step", tangentMode: "auto" },
		{ id: "second", time: t(1), value: 1, segmentToNext: "linear", tangentMode: "auto" },
	]);
	const before = ed.scenes.getActiveScene().tracks.main.elements[0].animations;
	run(ed, "first", { segmentToNext: "linear" });
	expect(ed.command.canUndo()).toBe(true);
	ed.command.undo();
	expect(ed.scenes.getActiveScene().tracks.main.elements[0].animations).toEqual(before);
});