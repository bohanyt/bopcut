import { getElementKeyframes } from "@/animation";
import type { EditorCore } from "@/core";
import { useTimelineStore } from "@/timeline/timeline-store";

/**
 * Shows the keyframe lanes of the selected clips that have keyframes, or hides them when all of
 * those are shown already (the clip context menu does the same for one clip).
 */
export function toggleSelectedKeyframeLanes(editor: EditorCore): void {
	const ids = editor.selection.getSelectedElements().flatMap(({ trackId, elementId }) => {
		const element = editor.timeline.getTrackById({ trackId })?.elements.find(({ id }) => id === elementId);
		return element && getElementKeyframes({ animations: element.animations }).length > 0 ? [element.id] : [];
	});
	if (ids.length === 0) return;
	const store = useTimelineStore.getState();
	const show = ids.some((id) => !store.expandedElementIds.has(id));
	store.setElementsExpanded(ids, show);
}
