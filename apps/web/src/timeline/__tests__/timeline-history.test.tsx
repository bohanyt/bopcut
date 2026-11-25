import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { getKeyframeById } from "@/animation";
import { EditorCore } from "@/core";
import { useEditorActions } from "@/actions/use-editor-actions";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { fixture, getHost, scene, t, video } from "@/timeline/__tests__/compound-fixtures";
import { BASE_TIMELINE_PIXELS_PER_SECOND as pps } from "@/timeline/scale";
import { DragDropController, type DragDropConfig } from "@/timeline/controllers/drag-drop-controller";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import type { MediaAsset } from "@/media/types";
import type { DragEvent as ReactDragEvent } from "react";

const fps = { numerator: 30, denominator: 1 };
let dom: Window;
let root: Root;
let editor: EditorCore;
let scenes: ReturnType<typeof fixture>;
let restoreGlobals: () => void;
let cleanup: (() => void)[];
beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
		Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
		IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
		cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
	};
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	EditorCore.reset();
	editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	scenes = fixture();
	cleanup = [];
	const { createRoot } = await import("react-dom/client");
	root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
	try {
		for (const end of cleanup) end();
		await act(async () => root.unmount());
		EditorCore.reset();
		await dom.close();
	} finally { restoreGlobals(); }
});
function start() {
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(10), createdAt: date, updatedAt: date },
		settings: { fps, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
		currentSceneId: "main", scenes, version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
}
function tracks() { return editor.scenes.getActiveScene().tracks; }
function main(...elements: ReturnType<typeof video>[]) {
	const host = getHost(scenes);
	host.tracks = { ...host.tracks, overlay: [], audio: [], main: { ...host.tracks.main, elements } };
}
function Shortcuts() {
	useEditorActions();
	useKeybindingsListener();
	return null;
}
async function press(key: string) {
	await act(async () => document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
test.each(["w", "s", "e", "q"])("%s preserves the one-frame minimum for an off-grid subtitle", async (key) => {
	main();
	start();
	const captions = parseSubtitleFile({ fileName: "cue.srt", input: "1\n00:00:00,020 --> 00:00:01,020\nCue\n" }).captions;
	const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
	editor.command.clear();
	const clip = tracks().overlay[0].elements[0];
	expect(clip.startTime).toBe(t(0.02));
	await act(async () => { root.render(<Shortcuts />); });
	await act(async () => {
		editor.selection.setSelectedElements({ elements: [{ trackId: trackId!, elementId: clip.id }] });
		editor.playback.seek({ time: key === "q" ? t(1) : t(1/30) });
	});
	const before = tracks();
	await press(key);
	expect(tracks()).toBe(before);
	expect(editor.command.canUndo()).toBe(false);
});

test("deleting a track retires its selected clip refs before the next Delete", async () => {
	start();
	await act(async () => { root.render(<Shortcuts />); });
	const ref = { trackId: "t-text", elementId: "title" };
	await act(async () => editor.selection.setSelectedElements({ elements: [ref] }));
	const before = tracks();
	await act(async () => editor.timeline.removeTrack({ trackId: ref.trackId }));
	const after = tracks();
	expect(editor.selection.getSelectedElements()).toEqual([]);
	await press("Delete");
	await act(async () => editor.command.undo());
	expect({ restored: tracks().overlay.some((track) => track.id === ref.trackId), selection: editor.selection.getSelectedElements() })
		.toEqual({ restored: true, selection: [ref] });
	expect(tracks()).toEqual(before);
	expect(editor.command.canUndo()).toBe(false);
	await act(async () => editor.command.redo());
	expect(tracks()).toEqual(after);
	expect(editor.selection.getSelectedElements()).toEqual([]);
});

test("Mute track on a text track is not an Undo step", () => {
	start();
	const before = tracks();
	editor.timeline.toggleTrackMute({ trackId: "t-text" });
	expect(tracks()).toEqual(before);
	expect(editor.command.canUndo()).toBe(false);
});

test("deleting a missing clip adds no Undo step", () => {
	start();
	const before = tracks();
	editor.timeline.deleteElements({ elements: [{ trackId: "t-text", elementId: "missing" }] });
	expect(tracks()).toBe(before);
	expect(editor.command.canUndo()).toBe(false);
});

test("Hide track on an audio track is not an Undo step", () => {
	start();
	const before = tracks();
	editor.timeline.toggleTrackVisibility({ trackId: "t-music" });
	expect(tracks()).toEqual(before);
	expect(editor.command.canUndo()).toBe(false);
});

test.each(["scene switch", "project switch", "multi-file drop"] as const)("timeline file import respects the edit boundary for %s", async (scenario) => {
	main(video("bg", 0, 10));
	const other = scene("other", { ...fixture()[0].tracks, overlay: [], audio: [], main: { ...fixture()[0].tracks.main, elements: [video("other-bg", 0, 10)] } });
	scenes.push(other);
	start();
	const file = new window.File([], "dragged.mp4");
	const media = { id: "import-1", name: file.name, type: "video", file, duration: 2 } as MediaAsset;
	const secondFile = new window.File([], "second.mp4");
	const secondMedia = { ...media, id: "import-2", name: secondFile.name, file: secondFile };
	const assets: MediaAsset[] = [];
	const pending = new Map<string, (asset: MediaAsset) => void>();
	const config: DragDropConfig = {
		zoomLevel: 1, getContainerEl: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) as HTMLDivElement,
		getHeaderEl: () => null, getTracksScrollEl: () => null, getActiveProjectFps: () => fps,
		startMediaImport: () => editor.media.startImport(),
		getSceneId: () => editor.scenes.getActiveSceneOrNull()?.id ?? null,
		getSceneTracks: tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(), getMediaAssets: () => assets,
		dragSource: editor.timeline.dragSource, importMediaFile: async ({ file }) => new Promise<MediaAsset>((resolve) => { pending.set(file.name, resolve); }),
		executeCommand: (command) => { editor.command.execute({ command }); },
		addClipEffect: (args) => editor.timeline.addClipEffect(args),
	};
	const controller = new DragDropController({ configRef: { current: config } });
	cleanup.push(() => controller.destroy());
	controller.onDrop({ preventDefault() {}, clientX: 12 * pps, clientY: 30, dataTransfer: { files: scenario === "multi-file drop" ? [file, secondFile] : [file], types: ["Files"] } } as unknown as ReactDragEvent);
	await dom.happyDOM.waitUntilComplete();
	expect(pending.get(file.name)).toBeFunction();
	if (scenario === "scene switch") {
		await editor.scenes.switchToScene({ sceneId: "other" });
	} else if (scenario === "project switch") {
		const prior = editor.project.getActive();
		editor.project.setActiveProject({ project: { ...prior, metadata: { ...prior.metadata, id: "other-project" } } });
		await editor.scenes.switchToScene({ sceneId: "other" });
	}
	const complete = async (asset: MediaAsset) => {
		assets.push(asset);
		await act(async () => pending.get(asset.name)!(asset));
	};
	const names = () => [...tracks().overlay, tracks().main, ...tracks().audio].flatMap((track) => track.elements.map((e) => e.name));
	const before = tracks();
	await complete(media);
	if (scenario !== "multi-file drop") {
		expect(tracks()).toBe(before);
		expect(editor.command.canUndo()).toBe(false);
	} else {
		expect(tracks()).toBe(before);
		expect(pending.get(secondFile.name)).toBeFunction();
		await complete(secondMedia);
		expect(names().filter((name) => name.endsWith(".mp4")).sort()).toEqual([file.name, secondFile.name]);
		const after = tracks();
		editor.command.undo();
		expect(tracks()).toEqual(before);
		expect(editor.command.canUndo()).toBe(false);
		editor.command.redo();
		expect(tracks()).toEqual(after);
	}
});

test("Undo of keyboard keyframe deletion restores the keyframe selection", async () => {
	const clip = video("a", 0, 5);
	clip.params.opacity = 1;
	clip.animations = { opacity: { keys: [
		{ id: "first", time: t(1), value: 0.5, segmentToNext: "linear", tangentMode: "flat" },
		{ id: "second", time: t(2), value: 1, segmentToNext: "linear", tangentMode: "flat" },
	] } };
	main(clip);
	start();
	await act(async () => { root.render(<Shortcuts />); });
	const ref = { trackId: tracks().main.id, elementId: clip.id, propertyPath: "opacity", keyframeId: "first" };
	await act(async () => {
		editor.selection.setSelectedElements({ elements: [{ trackId: ref.trackId, elementId: ref.elementId }] });
		editor.selection.setSelectedKeyframes({ keyframes: [ref], anchorKeyframe: ref });
	});
	const first = () => getKeyframeById({ animations: tracks().main.elements[0].animations, propertyPath: "opacity", keyframeId: "first" });
	expect(first()?.time).toBe(t(1));
	await press("Delete");
	expect(first()).toBeNull();
	expect(editor.selection.getSelectedKeyframes()).toEqual([]);
	await act(async () => editor.command.undo());
	expect(first()?.time).toBe(t(1));
	expect(editor.selection.getSelectedKeyframes()).toEqual([ref]);
	expect(editor.selection.getSnapshot().keyframeSelectionAnchor).toEqual(ref);
	expect(editor.command.canUndo()).toBe(false);
	await act(async () => editor.command.redo());
	expect(first()).toBeNull();
	expect(editor.selection.getSnapshot().keyframeSelectionAnchor).toBeNull();
});
