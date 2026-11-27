import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { requestAgentCheck, useRequestedNote } = await import("./agent-check");

let editor: ReturnType<typeof EditorCore.getInstance>;
beforeEach(() => {
	EditorCore.reset();
	editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks = { overlay: [], main: { ...host.tracks.main, elements: [video("bg", 0, 4), video("next", 4, 4)] }, audio: [] };
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	useRequestedNote.setState({ id: null });
});
afterEach(() => EditorCore.reset());

const notes = () => editor.scenes.getActiveScene().bookmarks;
const note = "Please check this part.";

test("a clip's check spans the clip, names it, opens the note and is one Undo step", () => {
	const id = requestAgentCheck({ editor, time: t(4), duration: t(4), elementIds: ["next"], note });
	expect(notes()).toEqual([{
		id: id!, note, author: "user", resolved: false, createdAt: expect.any(String), elementIds: ["next"], duration: t(4), time: t(4),
	}]);
	expect(useRequestedNote.getState().id).toBe(id);
	editor.command.undo();
	expect(notes()).toEqual([]);
});

test("a moment's check marks its frame, and past the end the last frame", () => {
	requestAgentCheck({ editor, time: t(1.01), note });
	requestAgentCheck({ editor, time: t(30), note });
	expect(notes().map(({ time, duration, elementIds }) => ({ time, duration, elementIds }))).toEqual([
		{ time: t(1), duration: undefined, elementIds: undefined },
		{ time: editor.timeline.getLastFrameTime(), duration: undefined, elementIds: undefined },
	]);
});

test("a span ends at the timeline's end", () => {
	requestAgentCheck({ editor, time: t(6), duration: t(5), note });
	expect(notes()[0].duration).toBe(t(2));
});

test("a note already at that frame is opened unchanged, and a plain marker there becomes the request", () => {
	editor.scenes.updateBookmark({ time: t(2), create: true, updates: { id: "kept", note: "Too fast?", author: "user" } });
	const before = notes();
	expect(requestAgentCheck({ editor, time: t(2), duration: t(1), note })).toBe("kept");
	expect(notes()).toBe(before);
	expect(useRequestedNote.getState().id).toBe("kept");

	void editor.scenes.toggleBookmark({ time: t(3) });
	const id = requestAgentCheck({ editor, time: t(3), note });
	expect(notes().filter(({ time }) => time === t(3))).toEqual([
		// The marker keeps its own fields (the selection it was added with).
		{ id: id!, note, author: "user", resolved: false, createdAt: expect.any(String), elementIds: [], time: t(3) },
	]);
});
