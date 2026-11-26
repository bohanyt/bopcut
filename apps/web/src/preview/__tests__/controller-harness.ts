import type { PointerEvent as ReactPointerEvent } from "react";
import { EditorCore } from "@/core";
import { PreviewPointerCapture } from "@/preview/pointer-capture";
import { SNAP_THRESHOLD_SCREEN_PIXELS, type SnapLine } from "@/preview/preview-snap";
import { fixture, getHost, rect, t } from "@/timeline/__tests__/compound-fixtures";
import type { GraphicElement, SceneTracks } from "@/timeline";

const CANVAS = { width: 1920, height: 1080 };

/** A render-only editor on a 1920×1080, 30 fps project, for driving the preview controllers in tests. */
export function previewEditor() {
	EditorCore.reset();
	const editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	const scenes = fixture();
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "Project", duration: t(10), createdAt: date, updatedAt: date },
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: CANVAS, background: { type: "color", color: "#000000" } },
			currentSceneId: "main",
			scenes,
			version: 1,
		},
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	const setTracks = (tracks: SceneTracks) => {
		getHost(scenes).tracks = tracks;
		editor.scenes.setScenes({ scenes: [...scenes], activeSceneId: "main" });
	};
	return { editor, scenes, setTracks };
}

export function graphic(id: string, params: Record<string, number | string>): GraphicElement {
	const base = rect(id, 0, 10);
	return {
		...base,
		params: {
			...base.params,
			"transform.positionX": 0, "transform.positionY": 0,
			"transform.scaleX": 1, "transform.scaleY": 1, "transform.rotate": 0,
			...params,
		},
	};
}

/** Pointer events in canvas pixels, with a target that holds pointer capture like a DOM element. */
export function pointer() {
	let captured = false;
	const target = {
		ownerDocument: Object.assign(new EventTarget(), { activeElement: null }),
		setPointerCapture: () => { captured = true; },
		hasPointerCapture: () => captured,
		releasePointerCapture: () => { captured = false; },
	};
	return (x: number, y: number, type: string) => ({
		clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, type,
		currentTarget: target, stopPropagation() {}, preventDefault() {},
	}) as unknown as ReactPointerEvent;
}

export function previewDeps(editor: EditorCore, snapLines: { current: SnapLine[] } = { current: [] }) {
	const getTracks = () => editor.scenes.getActiveScene().tracks;
	return {
		viewport: {
			pointerCapture: new PreviewPointerCapture(),
			screenToCanvas: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX, y: clientY }),
			screenPixelsToLogicalThreshold: () => ({ x: SNAP_THRESHOLD_SCREEN_PIXELS, y: SNAP_THRESHOLD_SCREEN_PIXELS }),
		},
		input: { isShiftHeld: () => false },
		scene: {
			getTracks,
			getCurrentTime: () => t(2),
			getMediaAssets: () => [],
			getCanvasSize: () => CANVAS,
			getSelectedElements: () => editor.selection.getSelectedElements(),
		},
		selection: {
			getSelected: () => editor.selection.getSelectedElements(),
			setSelected: (elements: readonly { trackId: string; elementId: string }[]) =>
				editor.selection.setSelectedElements({ elements: [...elements] }),
			clearSelection: () => editor.selection.clearSelection(),
		},
		timeline: {
			getElementsWithTracks: ({ elements }: { elements: readonly { trackId: string; elementId: string }[] }) =>
				editor.timeline.getElementsWithTracks({ elements: [...elements] }),
			previewElements: (updates: Parameters<EditorCore["timeline"]["previewElements"]>[0]["updates"]) =>
				editor.timeline.previewElements({ updates }),
			commitPreview: () => editor.timeline.commitPreview(),
			beginPreviewGesture: editor.timeline.beginPreviewGesture,
		},
		preview: { isMaskMode: () => false, onSnapLinesChange: (lines: SnapLine[]) => { snapLines.current = lines; } },
		playback: { getIsPlaying: () => false, subscribe: () => () => {} },
	};
}
