import { useEffect, useReducer, useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import type { OnSnapLinesChange } from "@/preview/hooks/use-preview-interaction";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import type { ElementWithBounds } from "@/preview/element-bounds";
import {
	TransformHandleController,
	type TransformHandleDeps,
} from "@/preview/controllers/transform-handle-controller";

export function useTransformHandles({
	onSnapLinesChange,
}: {
	onSnapLinesChange?: OnSnapLinesChange;
}) {
	const viewport = usePreviewViewport();
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const deps: TransformHandleDeps = {
		viewport,
		input: {
			isShiftHeld: () => isShiftHeldRef.current,
		},
		scene: {
			getSelectedElements: () => editor.selection.getSelectedElements(),
			getTracks: () => editor.timeline.getPreviewTracks() ?? editor.scenes.getActiveScene().tracks,
			getCurrentTime: () => editor.playback.getCurrentTime(),
			getMediaAssets: () => editor.media.getAssets(),
			getCanvasSize: () => editor.project.getActive().settings.canvasSize,
		},
		timeline: {
			previewElements: (updates) =>
				editor.timeline.previewElements({ updates }),
			commitPreview: () => editor.timeline.commitPreview(),
			beginPreviewGesture: editor.timeline.beginPreviewGesture,
		},
		preview: {
			onSnapLinesChange,
		},
	};
	const depsRef = useCommittedRef(deps);
	const [controller] = useState(
		() => new TransformHandleController({ depsRef }),
	);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => () => controller.destroy(), [controller]);

	const selection = useEditor(() => {
		const entry = controller.selectedWithBounds;
		if (!entry) return null;
		const { cx, cy, width, height, rotation } = entry.bounds;
		return [entry.trackId, entry.elementId, entry.element, cx, cy, width, height, rotation] as const;
	});
	let selectedWithBounds: ElementWithBounds | null = null;
	if (selection) {
		const [trackId, elementId, element, cx, cy, width, height, rotation] = selection;
		selectedWithBounds = {
			trackId, elementId, element, bounds: { cx, cy, width, height, rotation },
		};
	}

	return {
		selectedWithBounds,
		hasVisualSelection: selectedWithBounds !== null,
		activeHandle: controller.activeHandle,
		handleCornerPointerDown: controller.onCornerPointerDown,
		handleEdgePointerDown: controller.onEdgePointerDown,
		handleRotationPointerDown: controller.onRotationPointerDown,
		handlePointerMove: controller.onPointerMove,
		handlePointerUp: controller.onPointerUp,
	};
}
