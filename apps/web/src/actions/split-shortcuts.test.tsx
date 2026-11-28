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

describe("shortcut recording", () => {
	test("a conflicting key ends recording, so editor shortcuts keep working", async () => {
		// The Radix dialog does not render in happy-dom; this test is about what the dialog does with keys.
		const plain = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
		// Module mocks last for the whole test process: the real dialog is put back at the end.
		const realDialog = { ...(await import("@/components/ui/dialog")) };
		mock.module("@/components/ui/dialog", () => ({
			Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
			DialogBody: plain, DialogContent: plain, DialogFooter: plain, DialogHeader: plain, DialogTitle: plain,
		}));
		const { ShortcutsDialog } = await import("./components/shortcuts-dialog");
		const { useKeybindingsStore } = await import("./keybindings-store");
		const { createRoot } = await import("react-dom/client");
		const dialogRoot = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
		await act(async () => { dialogRoot.render(<ShortcutsDialog isOpen onOpenChange={() => {}} />); });
		try {
			const chips = [...dom.document.querySelectorAll("button[title]")] as unknown as HTMLButtonElement[];
			const chip = chips.find((button) => button.textContent?.trim().toLowerCase() === "w");
			if (!chip) throw new Error("Expected the W chip");
			await act(async () => { chip.click(); });
			expect(useKeybindingsStore.getState().isRecording).toBe(true);
			// S already splits: recording W's action on it is a conflict.
			await press("s");
			expect(useKeybindingsStore.getState().isRecording).toBe(false);
		} finally {
			await act(async () => { dialogRoot.unmount(); });
			mock.module("@/components/ui/dialog", () => realDialog);
		}
		expect(useKeybindingsStore.getState().isRecording).toBe(false);
		await press("s");
		expect(clips().bg).toEqual([[0, 1], [1, 4]]);
	});
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

describe("select all", () => {
	async function ctrlA(target: { dispatchEvent(event: unknown): boolean }) {
		const event = new dom.KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}
	const field = (type: string) => {
		const input = dom.document.createElement("input");
		input.type = type;
		dom.document.body.append(input);
		input.focus();
		return input;
	};

	test.each(["range", "checkbox"])("Ctrl+A in a %s selects every clip, not the page's text", async (type) => {
		const control = field(type);
		const event = await ctrlA(control);
		expect(event.defaultPrevented).toBe(true);
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0", "next@4", "title@0"]);
		control.remove();
	});

	test("A deselects what Ctrl+A selected; typed in a text field it deselects nothing", async () => {
		await ctrlA(dom.document.body);
		const input = field("text");
		await pressKey("a", "KeyA");
		expect(editor.selection.getSelectedElements()).toHaveLength(4);
		input.remove();
		await pressKey("a", "KeyA");
		expect(editor.selection.getSelectedElements()).toEqual([]);
	});

	test.each(["text", "number"])("Ctrl+A in a %s field selects its own text", async (type) => {
		const input = field(type);
		const event = await ctrlA(input);
		expect(event.defaultPrevented).toBe(false);
		expect(editor.selection.getSelectedElements()).toEqual([]);
		input.remove();
	});
});

async function pressKey(key: string, code: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
	await act(async () => {
		dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key, code, ...modifiers, bubbles: true, cancelable: true }));
	});
}

describe("cut", () => {
	test("Ctrl+X removes the selected clips in one Undo step, and Ctrl+V pastes them with their spacing", async () => {
		await select(bg, next);
		await pressKey("x", "KeyX", { ctrlKey: true });
		expect(clips()).toEqual({ title: [[0, 4]], music: [[0, 4]] });
		await act(async () => { editor.command.undo(); });
		expect(clips()).toEqual(whole);
		expect(editor.command.canUndo()).toBe(false);
		// Pasting checks that the clips' media are in the project.
		editor.media.setAssets({ assets: ["media-bg", "media-next"].map((id) => ({ id, name: id, type: "video", duration: 10 })) as never });
		await act(async () => { editor.playback.seek({ time: t(8) }); });
		await pressKey("v", "KeyV", { ctrlKey: true });
		expect(clips().bg).toEqual([[0, 4], [8, 12]]);
		expect(clips().next).toEqual([[4, 8], [12, 16]]);
	});

	test("Ctrl+X without a selection changes nothing", async () => {
		await pressKey("x", "KeyX", { ctrlKey: true });
		expect(clips()).toEqual(whole);
		expect(editor.command.canUndo()).toBe(false);
	});
});

describe("select beside the playhead", () => {
	test("] selects what ends after the playhead, [ what starts before it, both with the clips under it", async () => {
		// At 4 s the clips only touch the playhead with an edge: each is on one side.
		await act(async () => { editor.playback.seek({ time: t(4) }); });
		await pressKey("]", "BracketRight");
		expect(selectedNames()).toEqual(["next@4"]);
		await pressKey("[", "BracketLeft");
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0", "title@0"]);
		// At 2 s three clips are under the playhead: both keys take them.
		await act(async () => { editor.playback.seek({ time: t(2) }); });
		await pressKey("]", "BracketRight");
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0", "next@4", "title@0"]);
		await pressKey("[", "BracketLeft");
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0", "title@0"]);
	});

	test("clips on a hidden track are left out", async () => {
		const scene = editor.scenes.getActiveScene();
		await act(async () => {
			editor.scenes.setScenes({
				scenes: editor.scenes.getScenes().map((item) => item.id === scene.id
					? { ...item, tracks: { ...item.tracks, overlay: item.tracks.overlay.map((track) => ({ ...track, hidden: true })) } }
					: item),
				activeSceneId: scene.id,
			});
			editor.playback.seek({ time: t(4) });
		});
		await pressKey("[", "BracketLeft");
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0"]);
	});
});

describe("select beside the playhead on picked tracks", () => {
	test("Shift+] and Shift+[ stay on the selected clips' tracks; with nothing selected they take every track", async () => {
		await select(bg);
		await act(async () => { editor.playback.seek({ time: t(2) }); });
		await pressKey("]", "BracketRight", { shiftKey: true });
		expect(selectedNames().sort()).toEqual(["bg@0", "next@4"]);
		await pressKey("[", "BracketLeft", { shiftKey: true });
		expect(selectedNames()).toEqual(["bg@0"]);
		await select();
		await pressKey("]", "BracketRight", { shiftKey: true });
		expect(selectedNames().sort()).toEqual(["bg@0", "music@0", "next@4", "title@0"]);
	});
});

describe("J/K/L shuttle", () => {
	test("L, L, L plays at 1×, 2× and 4×; K stops at normal speed; J plays backward; Shift+L still steps 1 s", async () => {
		const raf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
		const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
		Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
		Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
		const state = () => [editor.playback.getIsPlaying(), editor.playback.getRate()];
		try {
			await pressKey("l", "KeyL");
			expect(state()).toEqual([true, 1]);
			await pressKey("l", "KeyL");
			expect(state()).toEqual([true, 2]);
			await pressKey("l", "KeyL");
			expect(state()).toEqual([true, 4]);
			await pressKey("k", "KeyK");
			expect(state()).toEqual([false, 1]);
			await pressKey("j", "KeyJ");
			expect(state()).toEqual([true, -1]);
			await pressKey("l", "KeyL");
			expect(state()).toEqual([true, 1]);
			await pressKey("k", "KeyK");
			const before = editor.playback.getCurrentTime();
			await pressKey("L", "KeyL", { shiftKey: true });
			expect(editor.playback.getCurrentTime() - before).toBe(t(1));
		} finally {
			if (raf) Object.defineProperty(globalThis, "requestAnimationFrame", raf);
			else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
			if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
			else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
		}
	});
});
