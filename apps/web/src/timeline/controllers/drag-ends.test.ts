import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorCore } from "@/core";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";
import { BASE_TIMELINE_PIXELS_PER_SECOND as pps } from "@/timeline/scale";
import { ElementInteractionController, type ElementInteractionDeps } from "./element-interaction-controller";
import { ResizeController, type ResizeConfig } from "./resize-controller";
import type { MouseEvent as ReactMouseEvent } from "react";

const fps = { numerator: 30, denominator: 1 };
let dom: Window;
let editor: EditorCore;
let previousDocument: PropertyDescriptor | undefined;
let destroyController: (() => void) | undefined;

beforeEach(() => {
	dom = new Window();
	previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
	editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.overlay = [];
	host.tracks.audio = [];
	host.tracks.main.elements = [video("lead", 0, 1), video("clip", 2, 3)];
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(5), createdAt: date, updatedAt: date },
		settings: { fps, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
		currentSceneId: "main", scenes, version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
});

afterEach(async () => {
	try {
		destroyController?.();
		destroyController = undefined;
		EditorCore.reset();
		await dom.close();
	} finally {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
	}
});

const tracks = () => editor.scenes.getActiveScene().tracks;
const clip = () => tracks().main.elements.find(({ id }) => id === "clip")!;

function mouse(type: string, clientX: number, button = 0) {
	dom.document.dispatchEvent(new dom.MouseEvent(type, { clientX, clientY: 30, button }));
}

function mouseDown(clientX: number, button = 0) {
	return {
		button, clientX, clientY: 30, stopPropagation() {}, preventDefault() {},
		currentTarget: {
			ownerDocument: dom.document,
			getBoundingClientRect: () => ({ left: clientX - 10 }),
		},
	} as unknown as ReactMouseEvent;
}

function mover(scroll = { scrollLeft: 0, scrollTop: 0 }) {
	const box = () => ({ left: 0, top: 0, width: 1000, height: 400 });
	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => 1,
			getTracksScrollEl: () => ({ ...scroll, getBoundingClientRect: box }) as HTMLDivElement,
			getTracksContainerEl: () => ({ getBoundingClientRect: box }) as HTMLDivElement,
			getHeaderEl: () => null,
		},
		input: { isShiftHeld: () => false },
		scene: { getTracks: tracks, getActiveFps: () => fps },
		selection: {
			getSelected: () => editor.selection.getSelectedElements(),
			isSelected: (ref) => editor.selection.getSelectedElements().some(
				(item) => item.elementId === ref.elementId && item.trackId === ref.trackId,
			),
			select: (ref) => editor.selection.setSelectedElements({ elements: [ref] }),
			handleClick: () => {},
			clearKeyframeSelection: () => editor.selection.clearKeyframeSelection(),
		},
		playback: { getCurrentTime: () => editor.playback.getCurrentTime() },
		timeline: {
			moveElements: (args) => editor.timeline.moveElements(args),
			beginPreviewGesture: editor.timeline.beginPreviewGesture,
		},
		snap: { isEnabled: () => false },
	};
	const controller = new ElementInteractionController({ depsRef: { current: deps } });
	destroyController = () => controller.destroy();
	return controller;
}

function resizer(overrides: Partial<ResizeConfig> = {}) {
	const config: ResizeConfig = {
		zoomLevel: 1, snappingEnabled: false, isShiftHeld: () => false, getSceneTracks: tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(), getActiveProjectFps: () => fps,
		selectedElements: [],
		beginPreviewGesture: editor.timeline.beginPreviewGesture,
		discardPreview: () => editor.timeline.discardPreview(),
		previewElements: (updates) => editor.timeline.previewElementUpdates({ updates }),
		commitElements: (updates) => editor.timeline.updateElements({ updates }),
		...overrides,
	};
	const controller = new ResizeController({ configRef: { current: config } });
	destroyController = () => controller.destroy();
	return controller;
}

test.each(["middle press", "secondary release", "window blur"] as const)("clip move does not commit on %s", (interruption) => {
	const controller = mover();
	controller.onElementMouseDown({
		event: mouseDown(2 * pps + 10, interruption === "middle press" ? 1 : 0),
		element: clip(), track: tracks().main,
	});
	mouse("mousemove", 3 * pps + 10);
	if (interruption === "window blur") dom.dispatchEvent(new dom.Event("blur"));
	const button = interruption === "secondary release" ? 2 : interruption === "middle press" ? 1 : 0;
	mouse("mouseup", 3 * pps + 10, button);
	expect(clip().startTime).toBe(t(2));
	expect(editor.command.canUndo()).toBe(false);
	expect(controller.view.kind).toBe(interruption === "secondary release" ? "dragging" : "idle");
});

test.each(["secondary press", "secondary release", "window blur"] as const)("trim does not commit on %s", (interruption) => {
	const controller = resizer();
	controller.onResizeStart({
		event: mouseDown(5 * pps, interruption === "secondary press" ? 2 : 0),
		element: clip(), track: tracks().main, side: "right",
	});
	mouse("mousemove", 4 * pps);
	if (interruption === "window blur") dom.dispatchEvent(new dom.Event("blur"));
	mouse("mouseup", 4 * pps, interruption === "window blur" ? 0 : 2);
	expect(clip().duration).toBe(t(3));
	expect(editor.command.canUndo()).toBe(false);
	expect(editor.timeline.isPreviewActive()).toBe(interruption === "secondary release");
});

test("clip move uses the drop position under the pointer after scrolling", () => {
	const scroll = { scrollLeft: 0, scrollTop: 0 };
	const controller = mover(scroll);
	controller.onElementMouseDown({ event: mouseDown(2 * pps + 10), element: clip(), track: tracks().main });
	mouse("mousemove", 3 * pps + 10);
	scroll.scrollLeft = pps;
	mouse("mouseup", 3 * pps + 10);
	expect(clip().startTime).toBe(t(4));
	editor.command.undo();
	expect(clip().startTime).toBe(t(2));
	expect(editor.command.canUndo()).toBe(false);
});

test("a trim previews once per frame it reaches and builds its snap points once", () => {
	const scene = tracks();
	let reads = 0;
	// Snap points read every clip of a track: count those reads.
	const counted = { ...scene, main: { ...scene.main, get elements() { reads++; return scene.main.elements; } } };
	let previews = 0;
	const snapPoints: unknown[] = [];
	const controller = resizer({
		zoomLevel: 10, snappingEnabled: true, getSceneTracks: () => counted,
		previewElements: (updates) => { previews++; editor.timeline.previewElementUpdates({ updates }); },
		onSnapPointChange: (point) => snapPoints.push(point),
	});
	const right = 5 * 10 * pps;
	const frame = (10 * pps) / 30;
	controller.onResizeStart({ event: mouseDown(right), element: clip(), track: tracks().main, side: "right" });
	mouse("mousemove", right - frame);
	const readsAfterFirstMove = reads;
	for (const x of [right - frame - 1, right - frame - 2, right - 2 * frame, right - 2 * frame - 1]) {
		mouse("mousemove", x);
	}
	expect(previews).toBe(2);
	expect(reads).toBe(readsAfterFirstMove);
	expect(snapPoints).toEqual([null, null, null, null, null]);
	mouse("mouseup", right - 2 * frame - 1);
	expect(clip().duration).toBe(t(3 - 2 / 30));
});
