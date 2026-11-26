import { afterEach, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { PreviewInteractionController } from "@/preview/controllers/preview-interaction-controller";
import { groupShortcutAction } from "@/preview/group-actions";
import { snapPosition, snapScale, snapScaleAxes, type SnapLine } from "@/preview/preview-snap";
import { text } from "@/timeline/__tests__/compound-fixtures";
import { graphic, pointer, previewDeps, previewEditor } from "./controller-harness";

afterEach(() => EditorCore.reset());

const canvasSize = { width: 1000, height: 1000 };
const snapThreshold = { x: 8, y: 8 };

test("snapping measures a flipped element by its size, and a flipped axis keeps its sign", () => {
	// A square flipped horizontally and turned 45°: its box must not shrink to nothing.
	const flipped = snapScale({ proposedScale: 1, position: { x: 145, y: 300 }, baseWidth: -200, baseHeight: 200, rotation: 45, canvasSize, snapThreshold });
	const plain = snapScale({ proposedScale: 1, position: { x: 145, y: 300 }, baseWidth: 200, baseHeight: 200, rotation: 45, canvasSize, snapThreshold });
	expect(flipped).toEqual(plain);
	expect(Number.isFinite(flipped.snappedScale) && Math.abs(flipped.snappedScale - 1) < 0.25).toBe(true);
	const moved = snapPosition({ proposedPosition: { x: 104, y: 300 }, canvasSize, elementSize: { width: -200, height: 200 }, snapThreshold });
	expect(moved).toEqual(snapPosition({ proposedPosition: { x: 104, y: 300 }, canvasSize, elementSize: { width: 200, height: 200 }, snapThreshold }));
	const axes = (scaleX: number, baseWidth: number) => snapScaleAxes({ proposedScaleX: scaleX, proposedScaleY: 1, position: { x: 104, y: 300 },
		baseWidth, baseHeight: 200, canvasSize, snapThreshold });
	const flippedAxes = axes(-1, -200), plainAxes = axes(1, 200);
	expect(flippedAxes.x.snappedScale).toBeCloseTo(-plainAxes.x.snappedScale, 9);
	expect(flippedAxes.x.activeLines).toEqual(plainAxes.x.activeLines);
});

test("dragging an unselected group snaps with the element under the pointer", () => {
	const { editor, scenes, setTracks } = previewEditor();
	const small = graphic("small", { "transform.positionX": 150, "transform.scaleX": 0.2, "transform.scaleY": 0.2 });
	const wide = graphic("wide", { "transform.positionX": 6, "transform.scaleX": 2, "transform.scaleY": 0.6 });
	small.groupId = wide.groupId = "group";
	setTracks({ ...scenes[0].tracks, overlay: [
		{ id: "t-small", name: "Small", type: "graphic", hidden: false, elements: [small] },
		{ id: "t-wide", name: "Wide", type: "graphic", hidden: false, elements: [wide] },
	] });
	editor.selection.clearSelection();
	const lines = { current: [] as SnapLine[] };
	const controller = new PreviewInteractionController({ depsRef: { current: previewDeps(editor, lines) } });
	const event = pointer();
	try {
		// The wide element sits 6 px right of the canvas center. Dragging it 5 px left brings it within
		// the 8 px threshold, so it snaps to the center and the small member moves by the same 6 px.
		controller.onPointerDown(event(966, 540, "pointerdown"));
		controller.onPointerMove(event(961, 540, "pointermove"));
		expect(lines.current.some((line) => line.type === "vertical" && line.position === 0)).toBe(true);
		const x = (id: string) => {
			const elements: { id: string; params: Record<string, unknown> }[] =
				(editor.timeline.getPreviewTracks()?.overlay ?? []).flatMap((track) => [...track.elements]);
			return elements.find((element) => element.id === id)?.params["transform.positionX"];
		};
		expect(x("wide")).toBe(0);
		expect(x("small")).toBe(144);
	} finally {
		controller.destroy();
	}
});

test("Escape while editing text on the canvas discards the typed text and leaves no Undo step", () => {
	const { editor, scenes, setTracks } = previewEditor();
	const title = text("title", 0, 10);
	title.params.content = "before";
	setTracks({ ...scenes[0].tracks, overlay: [{ id: "t-text", name: "Text", type: "text", hidden: false, elements: [title] }] });
	const controller = new PreviewInteractionController({ depsRef: { current: previewDeps(editor) } });
	try {
		// Enter text editing as a double-click does: a preview gesture plus the edited element.
		const internals = controller as unknown as {
			gestureOwner: ReturnType<typeof editor.timeline.beginPreviewGesture> | null;
			editingTextState: { trackId: string; elementId: string; element: typeof title } | null;
		};
		internals.gestureOwner = editor.timeline.beginPreviewGesture(() => {});
		internals.editingTextState = { trackId: "t-text", elementId: "title", element: title };
		controller.previewTextEdit("after edit");
		controller.cancelTextEdit();
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.scenes.getActiveScene().tracks.overlay[0].elements[0]).toMatchObject({ params: { content: "before" } });
		expect(editor.command.canUndo()).toBe(false);
		expect(controller.editingText).toBeNull();
		// The blur that follows the Escape commits nothing.
		controller.commitTextEdit();
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		controller.destroy();
	}
});

test("Ctrl+G groups once per press, never while a dialog is open or a field has focus", () => {
	const key = (init: Partial<KeyboardEvent> & { target?: unknown } = {}) =>
		({ key: "g", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, ...init }) as Parameters<typeof groupShortcutAction>[0];
	const idle = { overlayDepth: 0, isRecording: false };
	expect(groupShortcutAction(key(), idle)).toBe("group");
	expect(groupShortcutAction(key({ shiftKey: true, key: "G" }), idle)).toBe("ungroup");
	expect(groupShortcutAction(key({ metaKey: true, ctrlKey: false }), idle)).toBe("group");
	expect(groupShortcutAction(key({ repeat: true }), idle)).toBeNull();
	expect(groupShortcutAction(key(), { overlayDepth: 1, isRecording: false })).toBeNull();
	expect(groupShortcutAction(key(), { overlayDepth: 0, isRecording: true })).toBeNull();
	expect(groupShortcutAction(key({ altKey: true }), idle)).toBeNull();
	expect(groupShortcutAction(key({ target: { tagName: "INPUT" } as unknown as EventTarget }), idle)).toBeNull();
	expect(groupShortcutAction(key({ key: "h" }), idle)).toBeNull();
});
