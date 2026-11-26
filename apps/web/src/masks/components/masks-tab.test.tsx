import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { MaskType } from "@/masks/types";
import type { VideoElement } from "@/timeline";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

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
const { buildDefaultMaskInstance } = await import("@/masks");
const { MasksTab } = await import("./masks-tab");

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

async function show(maskType: MaskType) {
	EditorCore.reset();
	editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const clip = { ...video("clip", 0, 4), masks: [buildDefaultMaskInstance({ maskType, elementSize: { width: 1920, height: 1080 } })] } as VideoElement;
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
	editor.playback.seek({ time: t(1) });
	function Panel() {
		const element = useEditor((e) => e.scenes.getActiveScene().tracks.main.elements[0]) as VideoElement;
		return <MasksTab element={element} trackId="t-main" />;
	}
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => {
		root.render(<LocaleProvider initialLocale="en"><TooltipProvider><Panel /></TooltipProvider></LocaleProvider>);
	});
}
const masks = () => (editor.scenes.getActiveScene().tracks.main.elements[0] as VideoElement).masks ?? [];
const content = () => (masks()[0].params as { content?: string }).content;
const fire = (target: { dispatchEvent: (event: never) => unknown }, event: unknown) =>
	act(async () => { target.dispatchEvent(event as never); });

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
beforeEach(() => { dom.document.body.innerHTML = ""; });
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

for (const maskType of ["rectangle", "text"] as const) {
	test(`every control of a ${maskType} mask has a name`, async () => {
		await show(maskType);
		const controls = [...dom.document.querySelectorAll("input, textarea, button")];
		expect(controls.length).toBeGreaterThan(5);
		const unnamed = controls.filter((control) => !control.getAttribute("aria-label") && !control.textContent?.trim());
		expect(unnamed.map((control) => control.outerHTML.slice(0, 120))).toEqual([]);
	});
}

test("the position fields say which axis they set", async () => {
	await show("rectangle");
	const labels = [...dom.document.querySelectorAll("input")].map((input) => input.getAttribute("aria-label"));
	expect(labels).toEqual(expect.arrayContaining(["Position X", "Position Y", "Width", "Height", "Feather", "Stroke width"]));
});

test("Escape in a text mask's content drops what was typed, without an Undo step", async () => {
	await show("text");
	const before = content();
	const field = dom.document.querySelector("textarea[aria-label='Content']")!;
	await fire(field, new dom.FocusEvent("focusin", { bubbles: true }) as never);
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, `${before} cat`);
		field.dispatchEvent(new dom.InputEvent("input", { bubbles: true }));
	});
	expect(editor.timeline.isPreviewActive()).toBe(true);
	await fire(field, new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
	await fire(field, new dom.FocusEvent("focusout", { bubbles: true }) as never);
	expect(editor.timeline.isPreviewActive()).toBe(false);
	expect(content()).toBe(before);
	expect((field as unknown as HTMLTextAreaElement).value).toBe(String(before));
	expect(editor.command.canUndo()).toBe(false);

	// Typing and leaving the field still writes it.
	await fire(field, new dom.FocusEvent("focusin", { bubbles: true }) as never);
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Hello");
		field.dispatchEvent(new dom.InputEvent("input", { bubbles: true }));
	});
	await fire(field, new dom.FocusEvent("focusout", { bubbles: true }) as never);
	expect(content()).toBe("Hello");
	expect(editor.command.canUndo()).toBe(true);
});
