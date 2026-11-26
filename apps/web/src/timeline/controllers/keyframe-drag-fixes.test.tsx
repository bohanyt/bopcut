import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Root } from "react-dom/client";
import type { TProject } from "@/project/types";
import type { ScalarAnimationKey } from "@/animation/types";
import { getChannel } from "@/animation";
import { applyAnimationPresets, PRESET_PARAM } from "@/animation/presets";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { KeyframeDragController } from "@/timeline/controllers/keyframe-drag-controller";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { AnimationTab } = await import("@/animation/components/animation-tab");

afterEach(() => EditorCore.reset());

function project(clip: ReturnType<typeof video>, { renderOnly = false } = {}) {
	EditorCore.reset();
	const editor = renderOnly ? EditorCore.createRenderOnly() : EditorCore.getInstance();
	if (renderOnly) editor.audio.dispose();
	editor.save.stop();
	const scenes = fixture();
	getHost(scenes).tracks.main.elements = [clip];
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

/** A keyframe drag on a clip with one opacity key at 1 s; the page stands in for the document. */
function keyframeDrag({ selected }: { selected: boolean }) {
	const clip = video("a", 0, 5);
	clip.animations = {
		opacity: { keys: [{ id: "k0", time: t(1), value: 0.5, segmentToNext: "linear", tangentMode: "auto" } satisfies ScalarAnimationKey] },
	};
	const editor = project(clip);
	const page = Object.assign(new EventTarget(), { activeElement: null, defaultView: new EventTarget() });
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: page });
	const ref = { trackId: "t-main", elementId: "a", propertyPath: "opacity", keyframeId: "k0" };
	let notifies = 0;
	const controller = new KeyframeDragController({
		configRef: {
			current: {
				zoomLevel: 1,
				getFps: () => ({ numerator: 30, denominator: 1 }),
				element: clip,
				displayedStartTime: t(0),
				selectedKeyframes: selected ? [ref] : [],
				isKeyframeSelected: () => selected,
				setKeyframeSelection: () => {},
				toggleKeyframeSelection: () => {},
				selectKeyframeRange: () => {},
				executeCommand: (command) => editor.command.execute({ command }),
				beginPreviewGesture: editor.timeline.beginPreviewGesture,
				seek: () => {},
				getTotalDuration: () => t(5),
			},
		},
	});
	controller.subscribe(() => {
		notifies += 1;
	});
	const down = (shiftKey: boolean) => controller.onKeyframeMouseDown({
		keyframes: [ref],
		event: {
			button: 0, clientX: 400, shiftKey, metaKey: false, ctrlKey: false,
			preventDefault() {}, stopPropagation() {}, currentTarget: { ownerDocument: page },
		} as unknown as ReactMouseEvent,
	});
	const move = (clientX: number) => page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX }));
	const up = () => page.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0 }));
	const keyTime = () => getChannel({
		animations: editor.scenes.getActiveScene().tracks.main.elements[0].animations,
		propertyPath: "opacity",
	})?.keys[0].time;
	const done = () => {
		controller.destroy();
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
	};
	return { editor, controller, down, move, up, keyTime, notifies: () => notifies, done };
}

test("dragging a keyframe redraws only when it reaches another frame", () => {
	const drag = keyframeDrag({ selected: true });
	try {
		drag.down(false);
		drag.move(400 + TIMELINE_DRAG_THRESHOLD_PX + 2);
		drag.move(460);
		const before = drag.notifies();
		const delta = drag.controller.keyframeDragState.deltaTicks;
		for (let tick = 0; tick < 20; tick++) drag.move(460);
		expect(drag.notifies()).toBe(before);
		expect(drag.controller.keyframeDragState.deltaTicks).toBe(delta);
		drag.move(520);
		expect(drag.notifies()).toBe(before + 1);
		drag.up();
		expect(drag.keyTime()).not.toBe(t(1));
	} finally {
		drag.done();
	}
});

test("a keyframe dragged with Shift held (not selected by it) lands where it was dropped, and Undo puts it back", () => {
	const drag = keyframeDrag({ selected: false });
	try {
		drag.down(true);
		drag.move(400 + TIMELINE_DRAG_THRESHOLD_PX + 2);
		drag.move(520);
		expect(drag.controller.keyframeDragState.deltaTicks).not.toBe(0);
		drag.up();
		expect(drag.keyTime()).not.toBe(t(1));
		drag.editor.command.undo();
		expect(drag.keyTime()).toBe(t(1));
	} finally {
		drag.done();
	}
});

test("Escape in an animation preset's length field drops the typed length", async () => {
	const dom = new Window({ url: "http://localhost/" });
	const globals = {
		window: dom, document: dom.document, navigator: dom.navigator,
		HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: dom.getComputedStyle.bind(dom),
	};
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	let root: Root | undefined;
	try {
		const clip = applyAnimationPresets(video("a", 0, 4), { in: { type: "fade" } });
		const editor = project(clip, { renderOnly: true });
		const { createRoot } = await import("react-dom/client");
		const mount = dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement;
		root = createRoot(mount);
		await act(async () => root!.render(<AnimationTab element={clip} trackId="t-main" />));
		const lengthOf = () => editor.scenes.getActiveScene().tracks.main.elements[0].params[PRESET_PARAM.inDuration];
		const initial = lengthOf();
		const input = mount.querySelector("input[aria-label='In length in seconds']") as HTMLInputElement;
		expect(input).not.toBeNull();
		const type = (key: "Escape" | "Enter") => act(async () => {
			input.focus();
			Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "2");
			input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
			input.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
		});

		await type("Escape");
		expect(lengthOf()).toBe(initial);
		expect(editor.command.canUndo()).toBe(false);

		await type("Enter");
		expect(lengthOf()).toBe(2);
	} finally {
		await act(async () => root?.unmount());
		await dom.close();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
