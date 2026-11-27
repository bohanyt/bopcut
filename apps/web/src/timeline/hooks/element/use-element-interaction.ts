import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	ElementInteractionController,
	type ElementInteractionDeps,
	type ElementInteractionDepsRef,
} from "@/timeline/controllers/element-interaction-controller";
import type { SnapPoint } from "@/timeline/snapping";
import type { ElementDragView } from "@/timeline";

interface UseElementInteractionProps {
	zoomLevel: number;
	tracksContainerRef: RefObject<HTMLDivElement | null>;
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	getTrackExpansionHeight?: (trackIndex: number) => number;
}

export function useElementInteraction({
	zoomLevel,
	tracksContainerRef,
	tracksScrollRef,
	headerRef,
	snappingEnabled,
	onSnapPointChange,
	getTrackExpansionHeight,
}: UseElementInteractionProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const selection = useElementSelection();

	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => zoomLevel,
			getTracksScrollEl: () => tracksScrollRef.current,
			getTracksContainerEl: () => tracksContainerRef.current,
			getHeaderEl: () => headerRef?.current ?? null,
			getTrackExtraHeight: getTrackExpansionHeight,
		},
		input: {
			isShiftHeld: () => isShiftHeldRef.current,
		},
		scene: {
			getTracks: () => editor.scenes.getActiveScene().tracks,
			getActiveFps: () => editor.project.getActive()?.settings.fps ?? null,
		},
		selection: {
			getSelected: () => selection.selectedElements,
			isSelected: selection.isElementSelected,
			select: selection.selectElement,
			handleClick: selection.handleElementClick,
			clearKeyframeSelection: () => editor.selection.clearKeyframeSelection(),
		},
		playback: {
			getCurrentTime: () => editor.playback.getCurrentTime(),
		},
		timeline: {
			moveElements: (args) => editor.timeline.moveElements(args),
			beginPreviewGesture: editor.timeline.beginPreviewGesture,
		},
		snap: {
			isEnabled: () => snappingEnabled,
			onChange: onSnapPointChange,
		},
	};
	const depsRef = useCommittedRef(deps) as ElementInteractionDepsRef;
	const [controller] = useState(
		() => new ElementInteractionController({ depsRef }),
	);

	// The owner re-renders when a drag starts or ends; what moves with it reads `useElementDragView`.
	const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
	const getIsDragging = useCallback(() => controller.view.kind === "dragging", [controller]);
	const isElementDragging = useSyncExternalStore(subscribe, getIsDragging, getIsDragging);

	useEffect(() => () => controller.destroy(), [controller]);

	return {
		controller,
		isElementDragging,
		handleElementMouseDown: controller.onElementMouseDown,
		handleElementClick: controller.onElementClick,
	};
}

/** The live drag, for the parts of the timeline that draw it: they re-render as it moves, the rest does not. */
export function useElementDragView(controller: ElementInteractionController): ElementDragView {
	const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
	const getView = useCallback(() => controller.view, [controller]);
	return useSyncExternalStore(subscribe, getView, getView);
}
