import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Mask, MaskType } from "@/masks/types";
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

async function show(maskType: MaskType, change: (mask: Mask) => Mask = (mask) => mask) {
	EditorCore.reset();
	editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const clip = { ...video("clip", 0, 4), masks: [change(buildDefaultMaskInstance({ maskType, elementSize: { width: 1920, height: 1080 } }))] } as VideoElement;
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

test("points selected on a freeform mask can be deleted with a button, as with the Delete key", async () => {
	const path = ["a", "b", "c", "d", "e"].map((id, index) => ({ id, x: index * 0.1, y: (index % 2) * 0.1, inX: 0, inY: 0, outX: 0, outY: 0 }));
	await show("freeform", (mask) => ({ ...mask, params: { ...mask.params, path, closed: true } }) as Mask);
	const pointIds = () => (masks()[0].params as { path: { id: string }[] }).path.map((point) => point.id);
	const button = () => dom.document.querySelector("button[aria-label='Delete selected points']") as unknown as HTMLButtonElement | null;
	expect(button()).toBeNull();

	const maskId = masks()[0].id;
	await act(async () => {
		editor.selection.setSelectedMaskPoints({ selection: { trackId: "t-main", elementId: "clip", maskId, pointIds: ["b", "d"] } });
	});
	expect(button()).not.toBeNull();
	await fire(button()!, new dom.MouseEvent("click", { bubbles: true }));
	expect(pointIds()).toEqual(["a", "c", "e"]);
	expect(editor.selection.getSelectedMaskPointSelection()).toBeNull();
	expect(button()).toBeNull();

	await act(async () => { editor.command.undo(); });
	expect(pointIds()).toEqual(["a", "b", "c", "d", "e"]);

	// Points of another mask do not show the button here.
	await act(async () => {
		editor.selection.setSelectedMaskPoints({ selection: { trackId: "t-main", elementId: "clip", maskId: "other", pointIds: ["b"] } });
	});
	expect(button()).toBeNull();
});

test("a box mask can be locked to the canvas where it is, and unlocked where it is on the clip", async () => {
	// A clip moved right and zoomed in, so its own space and the canvas differ.
	await show("rectangle", (mask) => ({ ...mask, params: { ...mask.params, centerX: 0.1, centerY: -0.05 } } as Mask));
	const clip = editor.scenes.getActiveScene().tracks.main.elements[0] as VideoElement;
	await act(async () => {
		editor.timeline.updateElements({ updates: [{ trackId: "t-main", elementId: clip.id, patch: { params: { ...clip.params, "transform.positionX": 200, "transform.scaleX": 2, "transform.scaleY": 2 } } }] });
	});
	const before = masks()[0].params as { centerX: number; width: number };
	const lock = dom.document.querySelector("button[aria-label='Keep the Rectangle mask still on the canvas while the clip moves']") as unknown as HTMLButtonElement;
	expect(lock.getAttribute("aria-pressed")).toBe("false");
	await act(async () => { lock.click(); });
	const locked = masks()[0].params as { centerX: number; width: number; canvasLocked?: boolean };
	expect(locked.canvasLocked).toBe(true);
	// The clip is twice the canvas wide: the box keeps its place, so its canvas fractions double.
	expect(locked.width).toBeCloseTo(before.width * 2, 6);
	expect(locked.centerX).toBeCloseTo((200 + before.centerX * 3840) / 1920, 6);
	expect(lock.getAttribute("aria-pressed")).toBe("true");
	await act(async () => { lock.click(); });
	const unlocked = masks()[0].params as { centerX: number; width: number; canvasLocked?: boolean };
	expect(unlocked.canvasLocked).toBe(false);
	expect(unlocked.centerX).toBeCloseTo(before.centerX, 6);
	expect(unlocked.width).toBeCloseTo(before.width, 6);
	await act(async () => { editor.command.undo(); });
	expect((masks()[0].params as { canvasLocked?: boolean }).canvasLocked).toBe(true);
});
