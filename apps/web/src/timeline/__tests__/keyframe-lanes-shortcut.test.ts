import { afterEach, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import { getDefaultShortcuts } from "@/actions/definitions";
import { useTimelineStore } from "@/timeline/timeline-store";
import { toggleSelectedKeyframeLanes } from "@/timeline/keyframe-lanes";
import { fixture, getHost, t, video } from "./compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

afterEach(() => {
	EditorCore.reset();
	useTimelineStore.setState({ expandedElementIds: new Set() });
});

test("U expands the keyframes of the selected keyframed clips, and collapses them when all are expanded", () => {
	expect(getDefaultShortcuts().get("u")).toBe("toggle-keyframe-lanes");
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const keyed = video("keyed", 0, 2);
	keyed.animations = { opacity: { keys: [{ id: "k", time: t(0), value: 1, segmentToNext: "linear", tangentMode: "auto" }] } };
	const other = { ...video("keyed-too", 2, 2), animations: keyed.animations };
	getHost(scenes).tracks.main.elements = [keyed, other, video("plain", 4, 2)];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	const expanded = () => [...useTimelineStore.getState().expandedElementIds].sort();
	editor.selection.setSelectedElements({
		elements: ["keyed", "keyed-too", "plain"].map((elementId) => ({ trackId: "t-main", elementId })),
	});

	// One of them already open: U opens the rest instead of closing it.
	useTimelineStore.getState().setElementsExpanded(["keyed"], true);
	toggleSelectedKeyframeLanes(editor);
	expect(expanded()).toEqual(["keyed", "keyed-too"]);
	toggleSelectedKeyframeLanes(editor);
	expect(expanded()).toEqual([]);

	// A selection without keyframes changes nothing.
	editor.selection.setSelectedElements({ elements: [{ trackId: "t-main", elementId: "plain" }] });
	toggleSelectedKeyframeLanes(editor);
	expect(expanded()).toEqual([]);
});
