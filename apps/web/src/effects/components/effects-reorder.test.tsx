import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { VisualElement } from "@/timeline";
import { fixture, getHost, video } from "@/timeline/__tests__/compound-fixtures";

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
const { buildDefaultEffectInstance } = await import("@/effects");
const { ReorderClipEffectsCommand } = await import("@/commands/timeline");
const { ClipEffectsTab } = await import("./effects-tab");

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
const CLIP = { trackId: "t-main", elementId: "bg" } as const;
let root: Root;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const clip = video("bg", 0, 10);
	clip.effects = ["fx0", "fx1", "fx2"].map((id) => buildDefaultEffectInstance({ effectType: "blur", id }));
	getHost(scenes).tracks.main.elements = [clip];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
}

const clipEffects = () => (EditorCore.getInstance().scenes.getActiveScene().tracks.main.elements[0] as VisualElement).effects ?? [];

function Panel() {
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	const element = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks.main.elements[0]) as VisualElement | undefined;
	return element ? <ClipEffectsTab element={element} trackId={CLIP.trackId} /> : null;
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
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en"><Panel /></LocaleProvider>); });
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

const rows = () => [...dom.document.querySelectorAll("li[draggable]")] as unknown as Element[];
const drag = (type: string, row: Element) => act(async () => {
	row.dispatchEvent(new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as Event);
});

describe("reordering clip effects", () => {
	test("an effect removed during a drag does not corrupt the drop", async () => {
		expect(rows()).toHaveLength(3);
		await drag("dragstart", rows()[2]);
		await act(async () => { EditorCore.getInstance().timeline.removeClipEffect({ ...CLIP, effectId: "fx0" }); });
		expect(rows()).toHaveLength(2);
		await drag("dragover", rows()[0]);
		await drag("drop", rows()[0]);
		expect(clipEffects().map((effect) => effect?.id)).toEqual(["fx2", "fx1"]);
	});

	test("a reorder with an index past the effects changes nothing and adds no Undo step", () => {
		const editor = EditorCore.getInstance();
		const before = clipEffects();
		editor.command.execute({ command: new ReorderClipEffectsCommand({ ...CLIP, fromIndex: 3, toIndex: 0 }) });
		expect(clipEffects()).toBe(before);
		expect(editor.command.canUndo()).toBe(false);
	});
});
