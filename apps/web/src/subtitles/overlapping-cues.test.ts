import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorCore } from "@/core";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { fixture, getHost, t } from "@/timeline/__tests__/compound-fixtures";
import type { TimelineTrack } from "@/timeline";

function spansOverlap(
	a: { startTime: number; duration: number },
	b: { startTime: number; duration: number },
) {
	return a.startTime < b.startTime + b.duration && b.startTime < a.startTime + a.duration;
}

let dom: Window;
let editor: EditorCore;
let restoreGlobals: () => void;

beforeEach(() => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		Node: dom.Node,
		Element: dom.Element,
		HTMLElement: dom.HTMLElement,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	EditorCore.reset();
	editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	const scenes = fixture();
	const host = getHost(scenes);
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", duration: t(0), createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000" },
			},
			version: 1,
		},
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
});

afterEach(async () => {
	await dom.close();
	EditorCore.reset();
	restoreGlobals();
});

function noOverlapOn(track: TimelineTrack) {
	const sorted = [...track.elements].sort((a, b) => a.startTime - b.startTime);
	return sorted.every((element, index) => index === 0 || !spansOverlap(sorted[index - 1], element));
}

test("an overlapping SRT cue ends where the next starts, so the import stays one track", () => {
	const srt = `1
00:00:01,000 --> 00:00:05,000
Speaker one

2
00:00:02,000 --> 00:00:04,000
Speaker two

3
00:00:05,000 --> 00:00:06,000
Speaker one again
`;
	const captions = parseSubtitleFile({ fileName: "overlap.srt", input: srt }).captions;
	const before = editor.scenes.getActiveScene().tracks.overlay.length;
	const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
	const overlay = editor.scenes.getActiveScene().tracks.overlay;
	expect(overlay.length).toBe(before + 1);
	expect(overlay[0].id).toBe(trackId!);
	expect(noOverlapOn(overlay[0])).toBe(true);
	expect(overlay[0].elements.map((element) => [element.startTime, element.duration]))
		.toEqual([[t(1), t(1)], [t(2), t(2)], [t(5), t(1)]]);
	// The shortened cue spreads its words over the time it is shown.
	const first = overlay[0].elements[0] as import("@/timeline").TextElement;
	expect(first.caption?.words.at(-1)?.end).toBeLessThanOrEqual(1);
	editor.command.undo();
	expect(editor.scenes.getActiveScene().tracks.overlay.length).toBe(before);
});

test("cues that start together go to separate tracks, and one Undo removes them all", () => {
	const before = editor.scenes.getActiveScene().tracks.overlay.length;
	insertCaptionChunksAsTextTrack({ editor, captions: [
		{ text: "Speaker one", startTime: 1, duration: 3 },
		{ text: "Speaker two", startTime: 1, duration: 2 },
		{ text: "Both done", startTime: 4, duration: 1 },
	] });
	const overlay = editor.scenes.getActiveScene().tracks.overlay;
	expect(overlay.length).toBe(before + 2);
	expect(overlay.slice(0, 2).every((track) => track.type === "text" && noOverlapOn(track))).toBe(true);
	expect(overlay.slice(0, 2).map((track) => track.elements.map((element) => element.startTime))).toEqual([[t(1), t(4)], [t(1)]]);
	editor.command.undo();
	expect(editor.scenes.getActiveScene().tracks.overlay.length).toBe(before);
});

test("cues that do not overlap stay on one track", () => {	const before = editor.scenes.getActiveScene().tracks.overlay.length;
	insertCaptionChunksAsTextTrack({ editor, captions: [
		{ text: "A", startTime: 1, duration: 1 },
		{ text: "B", startTime: 2, duration: 2 },
	] });
	const overlay = editor.scenes.getActiveScene().tracks.overlay;
	expect(overlay.length).toBe(before + 1);
	expect(overlay[0].elements.map((element) => element.startTime)).toEqual([t(1), t(2)]);
});
