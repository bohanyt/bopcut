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
	return { trackId, trackType, layer: 0, element: withoutId };
}

/** Names of the visual layers from the top down, without empty ones. */
function layers(tracks: SceneTracks) {
	return [...tracks.overlay, tracks.main].map((track) => track.elements.map(({ name }) => name)).filter((names) => names.length);
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
		expect(ed.scenes.getActiveScene().tracks.overlay).toEqual([]);
		ed.command.redo();
		const again = ed.scenes.getActiveScene().tracks.overlay.find((tr) => tr.elements.some((el) => el.name === "a"));
		expect(again?.elements.map((el) => el.startTime)).toEqual([t(2), t(4.5)]);

		const end = fixture();
		const endTime = 10;
		getHost(end).tracks = { overlay: [], main: { ...getHost(end).tracks.main, elements: [video("tail", 0, endTime)] }, audio: [] };
		const endEd = setup(end);
		paste(endEd, endTime, pair);
		tracks = endEd.scenes.getActiveScene().tracks;
		expect(starts(tracks, "t-main")).toEqual([t(0), t(endTime), t(endTime + 2.5)]);
	});
});

describe("pasted layers", () => {
	const copied = [
		{ trackId: "t-text", elementId: "title" },
		{ trackId: "t-gfx", elementId: "box" },
		{ trackId: "t-music", elementId: "music" },
	];
	const orders = [copied, [...copied].reverse()];

	function copy(editor: ReturnType<typeof setup>, elements: typeof copied) {
		editor.selection.setSelectedElements({ elements });
		expect(editor.clipboard.copy()).toBe(true);
	}

	test.each(orders)("keep their order in a scene without the source tracks", (...elements) => {
		const editor = setup();
		editor.media.setAssets({ assets: [{ id: "media-music", name: "music", type: "audio", file: new File([], "music.mp3") }] });
		copy(editor, elements);
		const empty = fixture();
		blankMain(empty);
		editor.scenes.setScenes({ scenes: empty, activeSceneId: "main" });
		expect(editor.clipboard.paste({ time: t(4) })).toBe(true);
		const pasted = editor.scenes.getActiveScene().tracks;
		expect(layers(pasted)).toEqual([["title"], ["box"]]);
		expect(pasted.audio.map((track) => track.elements.map(({ startTime }) => startTime))).toEqual([[t(4.5)]]);
		expect(editor.selection.getSelectedElements().map(({ trackId }) => allTracks(pasted).find(({ id }) => id === trackId)?.type))
			.toEqual(elements.map(({ trackId }) => trackId === "t-text" ? "text" : trackId === "t-gfx" ? "graphic" : "audio"));
		editor.command.undo();
		expect(editor.scenes.getActiveScene().tracks.overlay).toEqual([]);
		editor.command.redo();
		expect(editor.scenes.getActiveScene().tracks).toEqual(pasted);
	});

	test.each(orders)("keep their order above an occupied place", (...elements) => {
		const editor = setup();
		editor.media.setAssets({ assets: [{ id: "media-music", name: "music", type: "audio", file: new File([], "music.mp3") }] });
		copy(editor, elements);
		expect(editor.clipboard.paste({ time: t(1) })).toBe(true);
		const { tracks } = editor.scenes.getActiveScene();
		expect(layers(tracks)).toEqual([["title"], ["box"], ["title"], ["box"], ["bg"]]);
		noOverlap(tracks);
	});

	test("use their own free tracks in the same scene", () => {
		const editor = setup();
		copy(editor, copied.slice(0, 2));
		expect(editor.clipboard.paste({ time: t(20) })).toBe(true);
		expect(layers(editor.scenes.getActiveScene().tracks)).toEqual([["title", "title"], ["box", "box"], ["bg"]]);
	});

	test.each([false, true])("stay on their own free tracks of the same type (reversed: %p)", (reversed) => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = {
			overlay: [
				{ id: "upper", name: "Upper", type: "text", hidden: false, elements: [text("upper", 0, 3)] },
				{ id: "box", name: "Box", type: "graphic", hidden: false, elements: [rect("box", 0, 3)] },
				{ id: "lower", name: "Lower", type: "text", hidden: false, elements: [text("lower", 0, 3)] },
				{ id: "pip", name: "Pip", type: "video", muted: false, hidden: false, elements: [video("pip", 0, 3)] },
			],
			main: { ...host.tracks.main, elements: [video("bg", 0, 5)] },
			audio: ["voice", "music"].map((id) => ({ id, name: id, type: "audio" as const, muted: false, elements: [audio(id, 0, 5)] })),
		};
		const editor = setup(scenes);
		editor.media.setAssets({ assets: ["bg", "pip", "voice", "music"].map((id) => ({
			id: `media-${id}`, name: id, type: id === "voice" || id === "music" ? "audio" : "video", file: new File([], id),
		})) });
		const ids = ["upper", "box", "lower", "pip", "bg", "voice", "music"];
		const elements = ids.map((id) => ({ trackId: id === "bg" ? host.tracks.main.id : id, elementId: id }));
		copy(editor, reversed ? elements.reverse() : elements);
		expect(editor.clipboard.paste({ time: t(6) })).toBe(true);
		const { tracks } = editor.scenes.getActiveScene();
		expect(allTracks(tracks).map((track) => track.elements.map(({ name }) => name))).toEqual(ids.map((id) => [id, id]));
	});

	test("one layer goes back to its own free track, below the layers that cover it", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = {
			overlay: [
				{ id: "pip", name: "Pip", type: "video", muted: false, hidden: false, elements: [video("pip", 10, 5)] },
				{ id: "title", name: "Title", type: "text", hidden: false, elements: [text("title", 0, 10)] },
			],
			main: { ...host.tracks.main, elements: [video("bg", 0, 5), video("next", 5, 5)] },
			audio: [],
		};
		const editor = setup(scenes);
		copy(editor, [{ trackId: host.tracks.main.id, elementId: "bg" }]);
		editor.timeline.deleteElements({ elements: [{ trackId: host.tracks.main.id, elementId: "bg" }] });
		expect(editor.clipboard.paste({ time: t(0) })).toBe(true);
		expect(layers(editor.scenes.getActiveScene().tracks)).toEqual([["pip"], ["title"], ["next", "bg"]]);
		expect(starts(editor.scenes.getActiveScene().tracks, host.tracks.main.id)).toEqual([t(0), t(5)]);
	});

	test("one layer does not go below its own track", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = {
			overlay: [
				{ id: "upper", name: "Upper", type: "text", hidden: false, elements: [text("upper", 0, 5)] },
				{ id: "box", name: "Box", type: "graphic", hidden: false, elements: [rect("box", 0, 10)] },
				{ id: "lower", name: "Lower", type: "text", hidden: false, elements: [text("lower", 8, 2)] },
			],
			main: { ...host.tracks.main, elements: [video("bg", 0, 5)] },
			audio: [],
		};
		const editor = setup(scenes);
		copy(editor, [{ trackId: "upper", elementId: "upper" }]);
		expect(editor.clipboard.paste({ time: t(2) })).toBe(true);
		expect(layers(editor.scenes.getActiveScene().tracks)).toEqual([["upper"], ["upper"], ["box"], ["lower"], ["bg"]]);
	});

	test("do not share a hidden or muted track of other clips", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = {
			overlay: [
				{ id: "hidden", name: "Hidden", type: "text", hidden: true, elements: [text("draft", 10, 5)] },
				{ id: "title", name: "Title", type: "text", hidden: false, elements: [text("title", 0, 5)] },
				{ id: "muted", name: "Muted", type: "video", muted: true, hidden: false, elements: [video("old", 10, 5)] },
			],
			main: { ...host.tracks.main, elements: [video("bg", 0, 5)] },
			audio: [
				{ id: "off", name: "Off", type: "audio", muted: true, elements: [audio("scratch", 10, 5)] },
				{ id: "on", name: "On", type: "audio", muted: false, elements: [audio("music", 0, 5)] },
			],
		};
		const editor = setup(scenes);
		editor.media.setAssets({ assets: ["bg", "music"].map((id) => ({
			id: `media-${id}`, name: id, type: id === "music" ? "audio" : "video", file: new File([], id),
		})) });
		const place = (elements: typeof copied) => {
			copy(editor, elements);
			expect(editor.clipboard.paste({ time: t(2) })).toBe(true);
			const { tracks } = editor.scenes.getActiveScene();
			const states = editor.selection.getSelectedElements().map(({ trackId }) => {
				const track = allTracks(tracks).find(({ id }) => id === trackId);
				return [track && "hidden" in track && track.hidden, track && "muted" in track && track.muted];
			});
			editor.command.undo();
			return states.flat();
		};
		const refs = [{ trackId: "title", elementId: "title" }, { trackId: host.tracks.main.id, elementId: "bg" }, { trackId: "on", elementId: "music" }];
		for (const elements of [...refs.map((ref) => [ref]), refs]) expect(place(elements)).not.toContain(true);
	});

	test("a copy of a hidden clip stays on its own track", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = { ...host.tracks, overlay: [{ id: "hidden", name: "Hidden", type: "text", hidden: true, elements: [text("draft", 0, 2)] }], audio: [] };
		const editor = setup(scenes);
		copy(editor, [{ trackId: "hidden", elementId: "draft" }]);
		expect(editor.clipboard.paste({ time: t(5) })).toBe(true);
		expect(starts(editor.scenes.getActiveScene().tracks, "hidden")).toEqual([t(0), t(5)]);
	});

	test("use the main track and the audio tracks of another scene in the same order", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		const track = <T extends "video" | "audio">(id: string, type: T, elements: never[] = []) => ({ id, name: id, type, muted: false, hidden: false, elements });
		host.tracks = {
			overlay: [track("V2", "video"), { id: "T1", name: "T1", type: "text", hidden: false, elements: [] }],
			main: { ...host.tracks.main, elements: [video("intro", 0, 5)] },
			audio: [track("A1", "audio"), track("A2", "audio")],
		};
		const editor = setup(scenes);
		paste(editor, 10, [
			{ ...clipItem("s-pip", "video", "pip", 0, 5), layer: 2 },
			{ ...clipItem("s-title", "text", "title", 0, 5), layer: 1 },
			{ ...clipItem("s-main", "video", "bg", 0, 5), layer: 0 },
			{ ...clipItem("s-voice", "audio", "voice", 0, 5), layer: -1 },
			{ ...clipItem("s-music", "audio", "music", 0, 5), layer: -2 },
		]);
		const { tracks } = editor.scenes.getActiveScene();
		expect(allTracks(tracks).map(({ id, elements }) => [id, elements.map(({ name }) => name)])).toEqual([
			["V2", ["pip"]], ["T1", ["title"]], ["t-main", ["intro", "bg"]], ["A1", ["voice"]], ["A2", ["music"]],
		]);
	});

	test("keep their times when the main track would move its first clip to zero", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = { overlay: [], main: { ...host.tracks.main, elements: [video("late", 2, 3)] }, audio: [] };
		const editor = setup(scenes);
		paste(editor, 1, [
			{ ...clipItem("s-title", "text", "title", 0, 2), layer: 1 },
			{ ...clipItem("s-main", "video", "clip", 0, 2), layer: 0 },
		]);
		const { tracks } = editor.scenes.getActiveScene();
		expect(layers(tracks)).toEqual([["title"], ["clip"], ["late"]]);
		expect(tracks.overlay.flatMap((row) => row.elements.map(({ startTime }) => startTime))).toEqual([t(1), t(1)]);
	});

	test("do not go below a layer they cover", () => {
		const editor = setup();
		copy(editor, copied.slice(0, 2));
		const flipped = fixture();
		const host = getHost(flipped);
		host.tracks = { ...host.tracks, overlay: [...host.tracks.overlay].reverse() };
		editor.scenes.setScenes({ scenes: flipped, activeSceneId: "main" });
		expect(editor.clipboard.paste({ time: t(20) })).toBe(true);
		expect(layers(editor.scenes.getActiveScene().tracks)).toEqual([["title"], ["box", "box"], ["title"], ["bg"]]);
	});

	test("share one free track when they do not overlap", () => {
		const editor = setup();
		paste(editor, 20, [
			{ ...clipItem("upper", "text", "a", 0, 1), layer: 2 },
			{ ...clipItem("lower", "text", "b", 2, 1), layer: 1 },
		]);
		expect(starts(editor.scenes.getActiveScene().tracks, "t-text")).toEqual([t(2), t(20), t(22)]);
	});
});
