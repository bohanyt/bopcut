import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { fixture } from "@/timeline/__tests__/compound-fixtures";

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
let toggles = 0;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.playback.toggle = () => { toggles++; };
}

/** A focused control, reached with the keyboard (Tab) or with a click. */
function focused(html: string, { byKeyboard }: { byKeyboard: boolean }) {
	const holder = dom.document.body.appendChild(dom.document.createElement("div"));
	holder.innerHTML = html;
	const element = holder.firstElementChild as unknown as HTMLElement;
	const matches = element.matches.bind(element);
	element.matches = (selector: string) => (selector === ":focus-visible" ? byKeyboard : matches(selector));
	element.focus();
	expect(dom.document.activeElement as unknown).toBe(element);
	return element;
}

async function press(key: string, target: HTMLElement) {
	const code = key === " " ? "Space" : `Key${key.toUpperCase()}`;
	await act(async () => { target.dispatchEvent(new dom.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }) as unknown as Event); });
}

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
	setup();
	toggles = 0;
	const { createRoot } = await import("react-dom/client");
	function Shortcuts() {
		useEditorActions();
		useKeybindingsListener();
		return null;
	}
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<Shortcuts />); });
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	dom.document.body.innerHTML = "";
	EditorCore.reset();
});

describe("keys of a control reached with the keyboard", () => {
	test("Space presses a focused button instead of playing; a letter shortcut still works", async () => {
		const editor = EditorCore.getInstance();
		editor.selection.setSelectedElements({ elements: [{ trackId: "t-main", elementId: "bg" }] });
		const button = focused("<button>Export</button>", { byKeyboard: true });
		await press(" ", button);
		expect(toggles).toBe(0);
		await press("a", button);
		expect(editor.selection.getSelectedElements()).toEqual([]);
	});

	test("Space and letters open and search a focused list instead of playing", async () => {
		const select = focused('<div role="combobox" tabindex="0">30 fps</div>', { byKeyboard: true });
		await press(" ", select);
		await press("k", select);
		expect(toggles).toBe(0);
	});

	test("after a click on a button, Space still plays", async () => {
		const button = focused("<button>Export</button>", { byKeyboard: false });
		await press(" ", button);
		expect(toggles).toBe(1);
	});
});
