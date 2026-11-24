import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ElementClipboardItem } from "@/clipboard";
import type { SceneTracks, TScene, TimelineTrack } from "@/timeline";
import { allElements, allTracks, audio, fixture, getHost, rect, t, text, video } from "./compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { PasteCommand } = await import("@/commands/timeline/clipboard");

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
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [{ id: "media-bg", name: "bg", type: "video", file: new File([], "bg.mp4") }] });
	return editor;
}

function clipItem(trackId: string, trackType: TimelineTrack["type"], id: string, start: number, duration: number): ElementClipboardItem {
	const element = trackType === "audio" ? audio(id, start, duration) : trackType === "text" ? text(id, start, duration) : trackType === "graphic" ? rect(id, start, duration) : video(id, start, duration);
	const { id: _id, ...withoutId } = element;
	return { trackId, trackType, element: withoutId };
}

function starts(tracks: SceneTracks, trackId: string) {
	return (allTracks(tracks).find((row) => row.id === trackId)?.elements ?? []).map((el) => el.startTime).sort((a, b) => a - b);
}

function noOverlap(tracks: SceneTracks) {
	for (const track of allTracks(tracks)) {
		const sorted = [...track.elements].sort((a, b) => a.startTime - b.startTime);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i - 1].startTime + sorted[i - 1].duration).toBeLessThanOrEqual(sorted[i].startTime);
		}
	}
}

function paste(editor: ReturnType<typeof setup>, time: number, items: ElementClipboardItem[]) {
	editor.command.execute({ command: new PasteCommand({ time: t(time), clipboardItems: items }) });
}

function blankMain(scenes: TScene[]) {
	const host = getHost(scenes);
	host.tracks = { overlay: [], main: { ...host.tracks.main, elements: [] }, audio: [] };
}

afterEach(() => EditorCore.reset());

describe("paste groups", () => {
	const pair = [clipItem("src-main", "video", "a", 1, 1), clipItem("src-main", "video", "b", 3.5, 1)];

	test("one track gap at zero, occupied main, and timeline end", () => {
		const atZero = fixture();
		blankMain(atZero);
		const editor = setup(atZero);
		paste(editor, 0, pair);
		let tracks = editor.scenes.getActiveScene().tracks;
		expect(starts(tracks, "t-main")).toEqual([t(0), t(2.5)]);
		noOverlap(tracks);
		editor.command.undo();
		editor.command.redo();
		expect(starts(editor.scenes.getActiveScene().tracks, "t-main")).toEqual([t(0), t(2.5)]);

		const occupied = fixture();
		getHost(occupied).tracks = { overlay: [], main: { ...getHost(occupied).tracks.main, elements: [video("blocker", 2, 2)] }, audio: [] };
		const ed = setup(occupied);
		paste(ed, 2, pair);
		tracks = ed.scenes.getActiveScene().tracks;
		expect(starts(tracks, "t-main")).toEqual([t(2)]);
		const row = tracks.overlay.find((tr) => tr.elements.some((el) => el.name === "a"))!;
		expect(row.elements.map((el) => el.startTime)).toEqual([t(2), t(4.5)]);
		noOverlap(tracks);
		ed.command.undo();
		ed.command.redo();
		expect(row.elements.map((el) => el.startTime)).toEqual([t(2), t(4.5)]);

		const end = fixture();
		const endTime = 10;
		getHost(end).tracks = { overlay: [], main: { ...getHost(end).tracks.main, elements: [video("tail", 0, endTime)] }, audio: [] };
		const endEd = setup(end);
		paste(endEd, endTime, pair);
		tracks = endEd.scenes.getActiveScene().tracks;
		expect(starts(tracks, "t-main")).toEqual([t(0), t(endTime), t(endTime + 2.5)]);
	});
});
