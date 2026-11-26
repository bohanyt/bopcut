import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GraphicElement } from "@/timeline";
import { fixture, getHost, t } from "@/timeline/__tests__/compound-fixtures";

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
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { buildGraphicElement } = await import("@/timeline/element-utils");
const { registerDefaultGraphics } = await import("@/graphics");
const { GraphicTab } = await import("./graphic-tab");

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

async function show() {
	registerDefaultGraphics();
	EditorCore.reset();
	editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const shape = { ...buildGraphicElement({ definitionId: "rectangle", startTime: t(0) }), id: "shape", duration: t(4) } as GraphicElement;
	getHost(scenes).tracks.main.elements = [shape as never];
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
		const element = useEditor((e) => e.scenes.getActiveScene().tracks.main.elements[0]) as unknown as GraphicElement;
		return <GraphicTab element={element} trackId="t-main" />;
	}
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => {
		root.render(<LocaleProvider initialLocale="en"><TooltipProvider><Panel /></TooltipProvider></LocaleProvider>);
	});
}
const strokeWidth = () => Number((editor.scenes.getActiveScene().tracks.main.elements[0] as unknown as GraphicElement).params.strokeWidth ?? 0);
const named = (label: string) => dom.document.querySelector(`button[aria-label='${label}']`) as unknown as HTMLButtonElement | null;
const click = (button: HTMLButtonElement) =>
	act(async () => { button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as never); });

test("the stroke toggle says whether it adds or removes the stroke", async () => {
	await show();
	expect(strokeWidth()).toBe(0);
	expect(named("Remove stroke")).toBeNull();
	await click(named("Add stroke")!);
	expect(strokeWidth()).toBeGreaterThan(0);
	expect(named("Add stroke")).toBeNull();
	await click(named("Remove stroke")!);
	expect(strokeWidth()).toBe(0);
});

test("every button of a shape's properties has a name", async () => {
	await show();
	const buttons = [...dom.document.querySelectorAll("button")];
	expect(buttons.length).toBeGreaterThan(0);
	// A title names a button too (the keyframe toggles have one).
	const unnamed = buttons.filter((button) => !button.getAttribute("aria-label") && !button.getAttribute("title") && !button.textContent?.trim());
	expect(unnamed.map((button) => button.outerHTML.slice(0, 120))).toEqual([]);
});
