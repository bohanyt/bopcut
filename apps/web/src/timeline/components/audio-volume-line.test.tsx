import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { audio } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { AudioVolumeLine } = await import("@/timeline/components/audio-volume-line");

let dom: Window;
let root: Root;
let restoreGlobals: () => void;
let frames: FrameRequestCallback[];
let rectReads: number;

beforeEach(async () => {
	dom = new Window();
	frames = [];
	rectReads = 0;
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		HTMLElement: dom.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
		cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {}; },
	};
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const prototype = dom.HTMLElement.prototype as unknown as Record<string, unknown>;
	prototype.getBoundingClientRect = () => {
		rectReads += 1;
		return { top: 0, bottom: 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: 0 };
	};
	prototype.setPointerCapture = () => {};
	prototype.releasePointerCapture = () => {};
	prototype.hasPointerCapture = () => true;
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await dom.close();
	restoreGlobals();
	EditorCore.reset();
});

const pointer = (type: string, clientY: number, clientX = 100) =>
	new dom.PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX, clientY }) as unknown as Event;

test("dragging the volume line previews once per frame and reads the clip's box once", async () => {
	const editor = EditorCore.getInstance();
	const preview = spyOn(editor.timeline, "previewElements");
	const commit = spyOn(editor.timeline, "commitPreview").mockImplementation(() => {});
	await act(async () => root.render(<AudioVolumeLine element={audio("music", 0, 4)} trackId="audio" />));
	const line = dom.document.querySelector(".cursor-ns-resize") as unknown as HTMLElement;
	rectReads = 0;

	await act(async () => line.dispatchEvent(pointer("pointerdown", 50)));
	const afterDown = preview.mock.calls.length;
	await act(async () => {
		for (const y of [45, 40, 35, 30, 25]) line.dispatchEvent(pointer("pointermove", y));
		// Moves along the line only (no vertical change) wait for the same frame.
		for (const x of [120, 140, 160]) line.dispatchEvent(pointer("pointermove", 25, x));
	});
	expect(preview.mock.calls.length).toBe(afterDown);
	expect(frames.length).toBe(1);

	await act(async () => frames.shift()!(0));
	expect(preview.mock.calls.length).toBe(afterDown + 1);

	await act(async () => line.dispatchEvent(pointer("pointermove", 10)));
	await act(async () => line.dispatchEvent(pointer("pointerup", 10)));
	// The move whose frame had not come yet is previewed before the commit.
	expect(preview.mock.calls.length).toBe(afterDown + 2);
	expect(commit).toHaveBeenCalledTimes(1);
	expect(rectReads).toBe(1);
});
