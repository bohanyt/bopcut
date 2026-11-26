import { afterEach, expect, mock, test } from "bun:test";
import type { TScene } from "@/timeline";
import type { TProject } from "@/project/types";
import { getChannel } from "@/animation";
import type { ScalarAnimationKey } from "@/animation/types";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

function setup(scenes: TScene[] = fixture()) {
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
	return editor;
}

afterEach(() => EditorCore.reset());

const copiedRightHandle = { dt: t(0.2), dv: 0.35 };

test("pasting copied Bezier keyframes keeps the outgoing curve handle of each one", () => {
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks = {
		overlay: [],
		main: { ...host.tracks.main, elements: [video("first", 0, 5), video("second", 5, 5)] },
		audio: [],
	};
	const editor = setup(scenes);
	const source = { trackId: host.tracks.main.id, elementId: "first" };
	const keys: ScalarAnimationKey[] = [
		{
			id: "k0",
			time: t(0),
			value: 0,
			segmentToNext: "bezier",
			tangentMode: "broken",
			rightHandle: copiedRightHandle,
		},
		{
			id: "k1",
			time: t(1),
			value: 1,
			segmentToNext: "linear",
			tangentMode: "auto",
		},
	];
	host.tracks.main.elements[0].animations = { opacity: { keys } };

	editor.selection.setSelectedKeyframes({
		keyframes: keys.map(({ id }) => ({ ...source, propertyPath: "opacity", keyframeId: id })),
	});
	expect(editor.clipboard.copy()).toBe(true);

	editor.selection.setSelectedElements({ elements: [{ trackId: source.trackId, elementId: "second" }] });
	expect(editor.clipboard.paste({ time: t(5) })).toBe(true);

	const pasted = getChannel({
		animations: editor.scenes.getActiveScene().tracks.main.elements[1].animations,
		propertyPath: "opacity",
	})?.keys
		.slice() as ScalarAnimationKey[] | undefined;
	const first = pasted
		?.slice()
		.sort((a, b) => a.time - b.time)[0];

	expect(first?.rightHandle).toEqual(copiedRightHandle);
});