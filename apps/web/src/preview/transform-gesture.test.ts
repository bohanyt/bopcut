import { test, expect, afterEach } from "bun:test";
import { EditorCore } from "@/core";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";
import type { VideoTrack } from "@/timeline";
import { PreviewInteractionController } from "@/preview/controllers/preview-interaction-controller";
import { TransformHandleController } from "@/preview/controllers/transform-handle-controller";
import { PreviewPointerCapture } from "@/preview/pointer-capture";
import { getCornerPosition } from "@/preview/element-bounds";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import { getChannel } from "@/animation";
import type { PointerEvent as ReactPointerEvent } from "react";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; EditorCore.reset(); });

const keys = (a: number, b: number) => ({ keys: [
	{ id: "a", time: t(0), value: a, segmentToNext: "linear" as const, tangentMode: "flat" as const },
	{ id: "b", time: t(2), value: b, segmentToNext: "linear" as const, tangentMode: "flat" as const },
] });

const clip = (id = "target", x = 0) => ({
	...video(id, 0, 4), agentId: id,
	params: { "transform.positionX": x, "transform.positionY": 0, "transform.scaleX": 0.2, "transform.scaleY": 0.2, "transform.rotate": 0, opacity: 1 },
});

function setup(subject: ReturnType<typeof clip> & Partial<Pick<ReturnType<typeof video>, "animations">>, extra?: VideoTrack) {
	const scenes = fixture();
	const root = getHost(scenes);
	root.tracks.main.elements = [subject];
	root.tracks.overlay = extra ? [extra] : [];
	root.tracks.audio = [];
	const editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	const date = new Date(0);
	const canvasSize = { width: 1000, height: 1000 };
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(4), createdAt: date, updatedAt: date },
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize,
			background: { type: "color", color: "#000000" },
		},
		currentSceneId: "main", scenes, version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.playback.seek({ time: t(1) });
	const ref = { trackId: root.tracks.main.id, elementId: subject.id };
	editor.selection.setSelectedElements({ elements: [ref, ...(extra ? [{ trackId: extra.id, elementId: extra.elements[0].id }] : [])] });
	const tracks = () => editor.scenes.getActiveScene().tracks;
	const rendered = () => editor.timeline.getPreviewTracks() ?? tracks();
	const scene = {
		getTracks: rendered,
		getCurrentTime: () => editor.playback.getCurrentTime(),
		getMediaAssets: () => [],
		getCanvasSize: () => canvasSize,
		getSelectedElements: () => editor.selection.getSelectedElements(),
	};
	const page = Object.assign(new EventTarget(), { activeElement: null });
	const captured = new Set<number>();
	const target = {
		ownerDocument: page,
		setPointerCapture: (id: number) => captured.add(id),
		hasPointerCapture: (id: number) => captured.has(id),
		releasePointerCapture: (id: number) => captured.delete(id),
	};
	const event = (x: number, y: number, type = "pointerup") => ({
		button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, type,
		currentTarget: target, pointerId: 1, stopPropagation() {},
	}) as unknown as ReactPointerEvent;
	const deps = {
		viewport: {
			pointerCapture: new PreviewPointerCapture(),
			screenToCanvas: ({clientX,clientY}: {clientX:number,clientY:number}) => ({x:clientX,y:clientY}),
			screenPixelsToLogicalThreshold: () => ({x:0,y:0}),
		},
		input: { isShiftHeld: () => true },
		timeline: {
			getElementsWithTracks: ({ elements }: { elements: readonly typeof ref[] }) => editor.timeline.getElementsWithTracks({ elements: [...elements] }),
			previewElements: (updates: Parameters<typeof editor.timeline.previewElements>[0]["updates"], options = { replace: true }) =>
				editor.timeline.previewElements({ updates, ...options }),
			commitPreview: () => editor.timeline.commitPreview(),
			beginPreviewGesture: editor.timeline.beginPreviewGesture,
		},
		scene,
		preview: { isMaskMode: () => false },
		selection: {
			getSelected: scene.getSelectedElements,
			setSelected: (elements: readonly typeof ref[]) => editor.selection.setSelectedElements({ elements: [...elements] }),
			clearSelection: () => editor.selection.clearSelection(),
		},
		playback: { getIsPlaying: () => false, subscribe: () => () => {} },
	};
	const body = new PreviewInteractionController({ depsRef: { current: deps } });
	const handles = new TransformHandleController({ depsRef: { current: { ...deps, preview: {} } } });
	dispose = () => { body.destroy(); handles.destroy(); };
	const element = () => tracks().main.elements[0];
	const preview = () => rendered().main.elements[0];
	const transform = () => {
		const el = preview();
		return resolveTransformAtTime({ baseTransform: buildTransformFromParams({params:el.params}), animations:el.animations, localTime:t(1) });
	};
	return { editor, body, handles, event, element, transform, tracks, preview };
}

function expectOneUndo(h: ReturnType<typeof setup>, before: ReturnType<typeof video>) {
	const after = h.element();
	expect(h.editor.command.canUndo()).toBe(true);
	h.editor.command.undo();
	expect(h.element()).toEqual(before);
	expect(h.editor.command.canUndo()).toBe(false);
	h.editor.command.redo();
	expect(h.element()).toEqual(after);
}

test("a canvas move writes an interpolated X key at pointer-down time", () => {
	const before = { ...clip(), animations: { "transform.positionX": keys(0, 100), "transform.positionY": keys(0, 0) } };
	const h = setup(before);
	h.body.onPointerDown(h.event(550, 500, "pointerdown"));
	h.editor.playback.seek({ time: t(1.5) });
	h.body.onPointerMove(h.event(580, 525, "pointermove"));
	h.body.onPointerMove(h.event(580, 500, "pointermove"));
	const preview = h.preview();
	expect(h.transform().position.x).toBe(80);
	expect(h.transform().position.y).toBe(0);
	expect(h.editor.command.canUndo()).toBe(false);
	h.body.onPointerUp(h.event(580, 500));
	const after = h.element();
	expect(after.params).toEqual(before.params);
	expect(after.animations).toEqual(preview.animations);
	expect(getChannel({ animations: after.animations, propertyPath: "transform.positionX" })?.keys.map(({ time, value }) => [time, value]))
		.toEqual([[t(0), 0], [t(1), 80], [t(2), 100]]);
	expect(after.animations?.["transform.positionY"]).toEqual(before.animations["transform.positionY"]);
	expect(after.humanFields).toEqual(["keyframes.transform.positionX"]);
	expectOneUndo(h, before);
});

test.each(["corner", "edge"] as const)("%s scaling keeps the authored scale keys", (handle) => {
	const before = { ...clip(), animations: { "transform.scaleX": keys(0.2, 0.4) } };
	const h = setup(before);
	const { bounds } = h.handles.selectedWithBounds!;
	const corner = "bottom-right";
	const pos = handle === "corner" ? getCornerPosition({ bounds, corner }) :
		{ x: bounds.cx + bounds.width / 2, y: bounds.cy };
	const x = bounds.cx + 2 * (pos.x - bounds.cx);
	const y = bounds.cy + 2 * (pos.y - bounds.cy);
	const event = h.event(pos.x, pos.y, "pointerdown");
	if (handle === "corner") h.handles.onCornerPointerDown({ event, corner });
	else h.handles.onEdgePointerDown({ event, edge: "right" });
	h.handles.onPointerMove({ event: h.event(x, y, "pointermove") });
	const preview = h.preview();
	expect(h.transform().scaleX).toBeCloseTo(0.6);
	h.handles.onPointerUp(h.event(x, y));
	const channel = getChannel({ animations: h.element().animations, propertyPath: "transform.scaleX" });
	expect(channel?.keys.map(({ time }) => time)).toEqual([t(0), t(1), t(2)]);
	expect(channel?.keys[0]).toEqual(before.animations["transform.scaleX"].keys[0]);
	expect(channel?.keys[2]).toEqual(before.animations["transform.scaleX"].keys[1]);
	expect(h.element().params["transform.scaleY"]).toBeCloseTo(handle === "corner" ? 0.4 : 0.2);
	expect(h.element().animations).toEqual(preview.animations);
	expect(h.element().params).toEqual(preview.params);
	expectOneUndo(h, before);
});

test.each([false, true])("rotation changes only the rotation property (keyed = %s)", (keyed) => {
	const before = { ...clip(), animations: {
		"transform.positionX": keys(0, 100),
		...(keyed && { "transform.rotate": keys(0, 30) }),
	} };
	const h = setup(before);
	if (keyed) h.editor.playback.seek({ time: t(2) });
	const { cx, cy } = h.handles.selectedWithBounds!.bounds;
	h.handles.onRotationPointerDown({ event: h.event(cx + 120, cy, "pointerdown") });
	h.handles.onPointerMove({ event: h.event(cx, cy + 120, "pointermove") });
	const preview = h.preview();
	h.handles.onPointerUp(h.event(cx, cy + 120));
	const after = h.element();
	expect(after.params).toEqual({ ...before.params, ...(!keyed && { "transform.rotate": 90 }) });
	expect(after.animations).toEqual(preview.animations);
	if (keyed) {
		expect(getChannel({ animations: after.animations, propertyPath: "transform.rotate" })?.keys[1]).toEqual({
			...before.animations["transform.rotate"]!.keys[1], value: 120,
		});
	}
	expect(after.humanFields).toEqual([keyed ? "keyframes.transform.rotate" : "params.transform.rotate"]);
	expectOneUndo(h, before);
});

test("a group handle follows the property rules for in-range and out-of-range members", () => {
	const before = { ...clip(), animations: { "transform.scaleX": keys(0.2, 0.4) } };
	const later = { ...clip("later", 100), startTime: t(2), animations: { "transform.scaleX": keys(0.2, 0.4) } };
	const overlay: VideoTrack = { id: "overlay", name: "Overlay", type: "video", hidden: false, muted: false, elements: [later] };
	const h = setup(before, overlay);
	const corner = "bottom-right";
	const { bounds } = h.handles.selectedWithBounds!;
	const pos = getCornerPosition({ bounds, corner });
	const x = bounds.cx + 2 * (pos.x - bounds.cx);
	const y = bounds.cy + 2 * (pos.y - bounds.cy);
	h.handles.onCornerPointerDown({ event: h.event(pos.x, pos.y, "pointerdown"), corner });
	h.handles.onPointerMove({ event: h.event(x, y, "pointermove") });
	h.handles.onPointerUp(h.event(x, y));
	expect(getChannel({ animations: h.element().animations, propertyPath: "transform.scaleX" })?.keys.map(({ time }) => time))
		.toEqual([t(0), t(1), t(2)]);
	const other = h.tracks().overlay[0].elements[0];
	expect(other.params["transform.scaleX"]).toBeCloseTo(0.4);
	expect(other.animations).toEqual(later.animations);
	h.editor.command.undo();
	expect(h.element()).toEqual(before);
	expect(h.tracks().overlay[0].elements[0]).toEqual(later);
	expect(h.editor.command.canUndo()).toBe(false);
});
