import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { audio, fixture, getHost } from "@/timeline/__tests__/compound-fixtures";

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
const { relativeVolumeUpdates } = await import("./multi-volume");

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

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	getHost(scenes).tracks.audio = [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [audio("voice", 0, 6, -3)] }];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.selection.setSelectedElements({ elements: [{ trackId: "audio", elementId: "voice" }] });
	return editor;
}

function Panel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	const elements = useEditor((e) => e.selection.getSelectedElements());
	const [selected] = editor.timeline.getElementsWithTracks({ elements });
	return selected && <ElementParamsTab element={selected.element} trackId="audio" paramKeys={["volume", "fadeIn", "fadeOut"]} sectionKey="audio" />;
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

describe("volume and fades with the mouse", () => {
	test("volume and both fades have a drag handle and a slider; fades reach half the clip", () => {
		const handles = [...dom.document.querySelectorAll("button.cursor-ew-resize")].map((button) => button.textContent);
		expect(handles).toEqual(["dB", "↗", "↘"]);
		const sliders = [...dom.document.querySelectorAll("[role=slider]")];
		expect(sliders.map((slider) => [slider.getAttribute("aria-valuemin"), slider.getAttribute("aria-valuemax"), slider.getAttribute("aria-valuenow")]))
			.toEqual([["-60", "20", "-3"], ["0", "3", "0"], ["0", "3", "0"]]);
	});
});

const stored = () => EditorCore.getInstance().scenes.getActiveScene().tracks.audio[0].elements[0].params as Record<string, number>;

describe("committing what the mouse changed", () => {
	test("a fade typed beyond half the clip is kept at half the clip", async () => {
		const input = dom.document.querySelector('input[aria-label="Fade in (s)"]') as unknown as HTMLInputElement;
		await act(async () => { input.focus(); });
		await act(async () => {
			Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "10");
			input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }) as unknown as Event);
		});
		await act(async () => { input.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event); });
		expect(stored().fadeIn).toBe(3);
	});

	test("dragging the volume slider saves the value on release, as one Undo step", async () => {
		const thumb = dom.document.querySelector("[role=slider]")!;
		const root = thumb.closest("[data-orientation]")!.parentElement!.closest("[data-orientation]") ?? thumb.closest("[data-orientation]")!;
		const track = root as unknown as HTMLElement & Record<string, unknown>;
		track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 10, width: 200, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		const captured = new Set<number>();
		Object.assign(track, {
			setPointerCapture: (id: number) => captured.add(id),
			hasPointerCapture: (id: number) => captured.has(id),
			releasePointerCapture: (id: number) => captured.delete(id),
		});
		const pointer = (type: string, clientX: number) => act(async () => {
			track.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, clientX, clientY: 5, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }) as unknown as Event);
		});
		await pointer("pointerdown", 175);
		await pointer("pointermove", 180);
		await pointer("pointerup", 180);
		expect(stored().volume).toBe(12);
		await act(async () => { EditorCore.getInstance().command.undo(); });
		expect(stored().volume).toBe(-3);
	});
});

test("a relative volume change moves each clip from its own level and stays within the range", () => {
	const start = new Map([["a", { trackId: "t", volume: -6 }], ["b", { trackId: "t", volume: 18 }], ["c", { trackId: "u", volume: -59 }]]);
	expect(relativeVolumeUpdates(start, 3).map(({ elementId, patch }) => [elementId, (patch as { params: { volume: number } }).params.volume]))
		.toEqual([["a", -3], ["b", 20], ["c", -56]]);
	expect(relativeVolumeUpdates(start, -5).map(({ patch }) => (patch as { params: { volume: number } }).params.volume)).toEqual([-11, 13, -60]);
});
