import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "@/i18n/translate";
import { t as seconds } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { KeyframeIndicators } = await import("./timeline-element");

// The components read the editor, which creates it: later test files expect none.
afterEach(() => EditorCore.reset());
const { BezierGraph, stepHandle } = await import("./graph-editor/bezier-graph");
const { customPresetLabel } = await import("./graph-editor/custom-presets-store");

test("a clip's keyframe diamonds say how many keyframes sit at which time, with a larger hit area", async () => {
	const ref = (keyframeId: string) => ({ trackId: "t", elementId: "e", propertyPath: "transform.positionX", keyframeId });
	// The selection is read from a store with no server snapshot: render in a document.
	const dom = new Window();
	const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const container = dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement;
	const root = createRoot(container);
	await act(async () => root.render(
		<KeyframeIndicators
			indicators={[
				{ time: seconds(0.5), offsetPx: 10, keyframes: [ref("a")] },
				{ time: seconds(1.25), offsetPx: 30, keyframes: [ref("b"), ref("c")] },
			]}
			dragState={{ isDragging: false, draggingKeyframeIds: new Set(), deltaTicks: 0 }}
			displayedStartTime={seconds(2)}
			elementLeft={0}
			onKeyframeMouseDown={() => {}}
			onKeyframeClick={() => {}}
			getVisualOffsetPx={({ indicatorOffsetPx }) => indicatorOffsetPx}
		/>,
	));
	const html = container.innerHTML;
	await act(async () => root.unmount());
	await dom.close();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	expect(html).toContain('aria-label="1 keyframe(s) at 2.5 s"');
	expect(html).toContain('aria-label="2 keyframe(s) at 3.25 s"');
	expect(html).toContain('aria-pressed="false"');
	expect(html).toContain("before:-inset-1");
	expect(html).toContain("pointer-coarse:before:-inset-2.5");
});

test("the curve handles are large, named, keyboard-movable sliders on a graph that keeps touch for itself", () => {
	const html = renderToStaticMarkup(<BezierGraph value={[0.25, 0.1, 0.25, 1]} />);
	expect(html).toContain("touch-none");
	expect(html.match(/role="slider"/g)).toHaveLength(2);
	expect(html).toContain('aria-label="Curve handle at the start (arrow keys move it)"');
	expect(html).toContain('aria-valuetext="x 0.25, y 0.1"');
	expect(html).toContain('r="12"');

	const value = [0.25, 0.1, 0.25, 1] as [number, number, number, number];
	expect(stepHandle({ value, handle: "c1", key: "ArrowRight", large: false })).toEqual([0.26, 0.1, 0.25, 1]);
	expect(stepHandle({ value, handle: "c2", key: "ArrowUp", large: true })).toEqual([0.25, 0.1, 0.25, 1.1]);
	expect(stepHandle({ value: [1, 1.5, 0, 0], handle: "c1", key: "ArrowRight", large: true })).toEqual([1, 1.5, 0, 0]);
	expect(stepHandle({ value, handle: "c1", key: "Enter", large: false })).toBeNull();
});

test("saved easing presets are named in the UI language", () => {
	expect(customPresetLabel("Custom 3", createTranslator("id"))).toBe("Kustom 3");
	expect(customPresetLabel("Custom 3", createTranslator("en"))).toBe("Custom 3");
	expect(customPresetLabel("Bounce kecil", createTranslator("id"))).toBe("Bounce kecil");
});
