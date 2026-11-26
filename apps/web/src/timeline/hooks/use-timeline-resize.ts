import { useCallback, useEffect, useReducer, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	ResizeController,
	type ResizeConfig,
} from "@/timeline/controllers/resize-controller";
import type { ResizeSide } from "@/timeline/group-resize";
import type { SnapPoint } from "@/timeline/snapping";
import type { ElementRef } from "@/timeline";

const NO_RESIZE_PINS: readonly ElementRef[] = [];

export type { ResizeSide };

interface UseTimelineResizeProps {
	zoomLevel: number;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useTimelineResize({
	zoomLevel,
	onSnapPointChange,
}: UseTimelineResizeProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);
	const { selectedElements } = useElementSelection();

	const config: ResizeConfig = {
		zoomLevel,
		snappingEnabled,
		isShiftHeld: () => isShiftHeldRef.current,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(),
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		selectedElements,
		discardPreview: () => editor.timeline.discardPreview(),
		beginPreviewGesture: editor.timeline.beginPreviewGesture,
		previewElements: (updates) => editor.timeline.previewElementUpdates({ updates }),
		commitElements: (updates) => editor.timeline.updateElements({ updates }),
		onSnapPointChange,
		getWords: ({ trackId, elementId }) => {
			const tracks = editor.scenes.getActiveScene().tracks;
			const track = [...tracks.overlay, tracks.main, ...tracks.audio].find((t) => t.id === trackId);
			const mediaId = (track?.elements.find((e) => e.id === elementId) as { mediaId?: unknown } | undefined)?.mediaId;
			return typeof mediaId === "string" ? editor.media.getAssets().find((asset) => asset.id === mediaId)?.words : undefined;
		},
	};
	const configRef = useCommittedRef(config);
	const [controller] = useState(() => new ResizeController({ configRef }));
	const [resizePins, setResizePins] =
		useState<readonly ElementRef[]>(NO_RESIZE_PINS);
	const handleResizeStart = useCallback<ResizeController["onResizeStart"]>(
		(args) => {
			controller.onResizeStart(args);
			if (!controller.isResizing) return;
			const { track, element } = args;
			const selection = configRef.current.selectedElements;
			setResizePins(
				selection.some(
					(ref) => ref.trackId === track.id && ref.elementId === element.id,
				)
					? selection
					: [{ trackId: track.id, elementId: element.id }],
			);
		},
		[controller, configRef],
	);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => () => controller.destroy(), [controller]);

	return {
		isResizing: controller.isResizing,
		resizePins: controller.isResizing ? resizePins : NO_RESIZE_PINS,
		handleResizeStart,
	};
}
