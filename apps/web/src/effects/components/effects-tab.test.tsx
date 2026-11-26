import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { VideoElement } from "@/timeline";
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
const { ClipEffectsTab } = await import("./effects-tab");

const dom = new Window();
const globals = {
	window: dom,
	document: dom.document,
	navigator: dom.navigator,
	Node: dom.Node,
	HTMLElement: dom.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root;
let editor: ReturnType<typeof EditorCore.getInstance>;

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
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

async function show(effectIds: string[]) {
	EditorCore.reset();
	editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const effects = effectIds.map((id) => buildDefaultEffectInstance({ effectType: "blur", id }));
	getHost(scenes).tracks.main.elements = [{ ...video("clip", 0, 4), effects } as VideoElement];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	function Panel() {
		const element = useEditor((e) => e.scenes.getActiveScene().tracks.main.elements[0]) as VideoElement;
		return <ClipEffectsTab element={element} trackId="t-main" />;
	}
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en"><Panel /></LocaleProvider>); });
}
const order = () => ((editor.scenes.getActiveScene().tracks.main.elements[0] as VideoElement).effects ?? []).map((effect) => effect.id);
const buttons = (label: string) =>
	[...dom.document.querySelectorAll(`button[aria-label='${label}']`)] as unknown as HTMLButtonElement[];
const click = (button: HTMLButtonElement) =>
	act(async () => { button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as never); });

test("an effect moves up and down with buttons, in one Undo step each", async () => {
	await show(["a", "b", "c"]);
	const up = buttons("Move Blur up");
	const down = buttons("Move Blur down");
	expect([up.length, down.length]).toEqual([3, 3]);
	// Nothing above the first, nothing below the last.
	expect([up[0].disabled, down[2].disabled, up[1].disabled, down[1].disabled]).toEqual([true, true, false, false]);

	await click(down[0]);
	expect(order()).toEqual(["b", "a", "c"]);
	await click(buttons("Move Blur up")[2]);
	expect(order()).toEqual(["b", "c", "a"]);
	await act(async () => { editor.command.undo(); });
	expect(order()).toEqual(["b", "a", "c"]);
});

test("a single effect has no move buttons", async () => {
	await show(["only"]);
	expect(buttons("Move Blur up").length + buttons("Move Blur down").length).toBe(0);
	expect(buttons("Remove Blur").length).toBe(1);
});
