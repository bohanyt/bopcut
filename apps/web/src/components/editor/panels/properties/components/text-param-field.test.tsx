import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { fixture, getHost, t, text } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
// Loaded before the globals below: some modules choose their code by the presence of a document.
const { EditorCore } = await import("@/core");
const { useEditor } = await import("@/editor/use-editor");
const { LocaleProvider } = await import("@/i18n/provider");
const { ElementParamsTab } = await import("./element-params-tab");

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
	getHost(scenes).tracks.overlay = [{ id: "text", name: "Text", type: "text", hidden: false, elements: [text("one", 0, 2), text("two", 2, 2)] }];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.selection.setSelectedElements({ elements: [{ trackId: "text", elementId: "one" }] });
	editor.playback.seek({ time: t(1) });
	return editor;
}

function Panel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	const elements = useEditor((e) => e.selection.getSelectedElements());
	const [selected] = editor.timeline.getElementsWithTracks({ elements });
	return selected && <ElementParamsTab element={selected.element} trackId="text" paramKeys={["content"]} sectionKey="text" />;
}

const field = () => dom.document.querySelector("textarea")!;
/** Types one key at the end, as the browser does: from what the field shows now. */
async function type(key: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field(), field().value + key);
		field().dispatchEvent(new dom.InputEvent("input", { bubbles: true }));
	});
}
const contents = () => editor.scenes.getActiveScene().tracks.overlay[0].elements.map(({ params }) => params.content);

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
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en"><Panel /></LocaleProvider>); });
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

describe("text in the properties panel", () => {
	test("keeps every typed key and commits them in one Undo step", async () => {
		const before = contents();
		for (const key of " cat") await type(key);
		expect(field().value).toBe(`${before[0]} cat`);
		expect(contents()).toEqual(before);
		await act(async () => { field().dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true })); });
		expect(contents()).toEqual([`${before[0]} cat`, before[1]]);
		await act(async () => { editor.command.undo(); });
		expect(contents()).toEqual(before);
		expect(field().value).toBe(String(before[0]));
		expect(editor.command.canUndo()).toBe(false);
	});

	test("belongs to the clip it was typed for when another one is selected", async () => {
		const before = contents();
		await type("!");
		await act(async () => { editor.selection.setSelectedElements({ elements: [{ trackId: "text", elementId: "two" }] }); });
		expect(contents()).toEqual([`${before[0]}!`, before[1]]);
		expect(field().value).toBe(String(before[1]));
	});

	test("without typing adds no Undo step", async () => {
		await act(async () => { field().dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true })); });
		expect(editor.command.canUndo()).toBe(false);
	});
});
