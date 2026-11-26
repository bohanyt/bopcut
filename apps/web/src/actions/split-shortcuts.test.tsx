import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ElementRef } from "@/timeline";
import { allTracks, audio, fixture, getHost, t, text, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
// Loaded before the globals below: some modules choose their code by the presence of a document.
const { EditorCore } = await import("@/core");
const { useEditorActions } = await import("./use-editor-actions");
const { useKeybindingsListener } = await import("./use-keybindings");

const dom = new Window();
const globals = {
	window: dom,
	document: dom.document,
	navigator: dom.navigator,
	Node: dom.Node,
	HTMLElement: dom.HTMLElement,
	HTMLInputElement: dom.HTMLInputElement,
	IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root;
let editor: ReturnType<typeof setup>;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks = {
		overlay: [{ id: "text", name: "Text", type: "text", hidden: false, elements: [text("title", 0, 4)] }],
		main: { ...host.tracks.main, elements: [video("bg", 0, 4), video("next", 4, 4)] },
		audio: [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [audio("music", 0, 4)] }],
	};
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

const source = (name: string) => name.replace(/ \((left|right)\)$/, "");
/** Start and end of every clip in seconds, by the name of the clip it came from. */
function clips() {
	const parts: Record<string, number[][]> = {};
	for (const track of allTracks(editor.scenes.getActiveScene().tracks)) {
		for (const { name, startTime, duration } of track.elements) {
			(parts[source(name)] ??= []).push([startTime / t(1), (startTime + duration) / t(1)]);
		}
	}
	return parts;
}

async function press(key: string, target: { dispatchEvent(event: unknown): boolean } = dom.document.body, repeat = false) {
	await act(async () => { target.dispatchEvent(new dom.KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true })); });
}
async function select(...elements: ElementRef[]) {
	await act(async () => { editor.selection.setSelectedElements({ elements }); });
}
const selectedNames = () => editor.timeline.getElementsWithTracks({ elements: editor.selection.getSelectedElements() })
	.map(({ element }) => `${source(element.name)}@${element.startTime / t(1)}`);

const title = { trackId: "text", elementId: "title" };
const bg = { trackId: "t-main", elementId: "bg" };
const next = { trackId: "t-main", elementId: "next" };
const whole = { title: [[0, 4]], bg: [[0, 4]], next: [[4, 8]], music: [[0, 4]] };

beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});
afterAll(async () => {
	await dom.close();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});
beforeEach(async () => {
	editor = setup();
	const { createRoot } = await import("react-dom/client");
	function Shortcuts() {
		useEditorActions();
		useKeybindingsListener();
		return null;
	}
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<Shortcuts />); });
	await act(async () => { editor.playback.seek({ time: t(1) }); });
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

describe("split shortcuts", () => {
	test.each(["q", "w", "e"])("%s does nothing without a selection or beside the selected clip", async (key) => {
		await press(key);
		await select(next);
		await press(key);
		expect(clips()).toEqual(whole);
		expect(editor.command.canUndo()).toBe(false);
	});

	test.each([
		["q", [[1, 4]]],
		["e", [[0, 1]]],
		["w", [[0, 1], [1, 4]]],
	] as const)("%s changes only the selected clip, in one Undo step", async (key, expected) => {
		await select(title);
		await press(key);
		expect(clips()).toEqual({ ...whole, title: expected.map((part) => [...part]) });
		await act(async () => { editor.command.undo(); });
		expect(clips()).toEqual(whole);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("w selects the right part", async () => {
		await select(bg);
		await press("w");
		expect(selectedNames()).toEqual(["bg@1"]);
	});

	test("s splits every clip at the playhead in one Undo step and selects nothing new", async () => {
		await press("s");
		const split = { title: [[0, 1], [1, 4]], bg: [[0, 1], [1, 4]], next: [[4, 8]], music: [[0, 1], [1, 4]] };
		expect(clips()).toEqual(split);
		expect(editor.selection.getSelectedElements()).toEqual([]);
		await act(async () => { editor.command.undo(); });
		expect(clips()).toEqual(whole);
		expect(editor.command.canUndo()).toBe(false);
		await act(async () => { editor.command.redo(); });
		expect(clips()).toEqual(split);
	});

	test("s splits every clip although one is selected, which stays selected as its right part", async () => {
		await select(title, next);
		await press("s");
		expect(clips()).toEqual({ title: [[0, 1], [1, 4]], bg: [[0, 1], [1, 4]], next: [[4, 8]], music: [[0, 1], [1, 4]] });
		expect(selectedNames().sort()).toEqual(["next@4", "title@1"]);
	});

	test.each(["s", "w"])("a held %s splits once, also while the playhead moves", async (key) => {
		await select(bg);
		await press(key);
		const once = clips();
		await act(async () => { editor.playback.seek({ time: t(2) }); });
		await select(...editor.selection.getSelectedElements());
		await press(key, dom.document.body, true);
		expect(clips()).toEqual(once);
	});

	test("typing in a field splits nothing", async () => {
		await select(title);
		const field = dom.document.createElement("input");
		dom.document.body.append(field);
		field.focus();
		for (const key of ["q", "w", "e", "s"]) await press(key, field);
		expect(clips()).toEqual(whole);
		field.remove();
	});
});
