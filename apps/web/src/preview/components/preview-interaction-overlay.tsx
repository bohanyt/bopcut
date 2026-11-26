import { useI18n } from "@/i18n/provider";
import { useState } from "react";
import { usePreviewCaptureTarget, usePreviewViewport } from "@/preview/components/preview-viewport";
import { usePreviewInteraction } from "@/preview/hooks/use-preview-interaction";
import type { SnapLine } from "@/preview/preview-snap";
import { TransformHandles } from "./transform-handles";
import { MaskHandles } from "./mask-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useEditor } from "@/editor/use-editor";
import { useBookmarkArea } from "@/timeline/bookmarks/area-state";

export function PreviewInteractionOverlay() {
	const { t } = useI18n();
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const editor = useEditor();
	const areaEditing = useBookmarkArea((state) => state.editing !== null);
	const viewport = usePreviewViewport();
	const captureTarget = usePreviewCaptureTarget();
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const activeTabPerType = usePropertiesStore((s) => s.activeTabPerType);

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const activeTrack = selectedRef
		? editor.timeline.getTrackById({ trackId: selectedRef.trackId })
		: null;
	const activeElement =
		activeTrack?.elements.find(
			(element) => element.id === selectedRef?.elementId,
		) ?? null;
	const isMaskMode = activeElement
		? activeTabPerType[activeElement.type] === "masks"
		: false;

	const {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onDoubleClick,
		editingText,
		commitTextEdit,
		cancelTextEdit,
		previewTextEdit,
	} = usePreviewInteraction({
		onSnapLinesChange: setSnapLines,
		isMaskMode,
	});

	const handlePointerDown = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerDown({ event })) {
			return;
		}

		onPointerDown(event);
	};

	return (
		<div className={areaEditing ? "invisible absolute inset-0" : "absolute inset-0"}>
			<div
				ref={captureTarget}
				className="absolute inset-0 pointer-events-auto"
				role="application"
				aria-label={t("preview.canvasLabel")}
				style={{
					cursor: viewport.isPanning
						? "grabbing"
						: viewport.canPan
							? "default"
							: undefined,
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onLostPointerCapture={onPointerUp}
				onDoubleClick={onDoubleClick}
				onDragStart={(e) => e.preventDefault()}
			/>
			{editingText ? (
				<TextEditOverlay
					element={editingText.element}
					onPreview={previewTextEdit}
					onCommit={commitTextEdit}
					onCancel={cancelTextEdit}
				/>
			) : isMaskMode ? (
				<MaskHandles onSnapLinesChange={setSnapLines} />
			) : (
				<TransformHandles onSnapLinesChange={setSnapLines} />
			)}
			<SnapGuides lines={snapLines} />
		</div>
	);
}
