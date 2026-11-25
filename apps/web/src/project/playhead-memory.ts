import type { EditorCore } from "@/core";

/**
 * Restores the playhead of the project that was opened and stores its place when the editor is left:
 * a seek by keys or playback writes nothing by itself. Returns the clean-up.
 */
export function rememberPlayhead(editor: EditorCore): () => void {
	const { playheadTime } = editor.project.getTimelineViewState();
	if (playheadTime !== undefined) editor.playback.seek({ time: playheadTime });

	const session = editor.project.getSession();
	const remember = () => {
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		if (!projectId || editor.project.getSession() !== session) return;
		editor.project.storePlayhead();
		// The page may be closing: the debounced write would come too late. A failed save keeps its own retries.
		if (editor.save.getIsDirty() && !editor.save.getLastError(projectId)) void editor.save.settleProject(projectId);
	};
	const onVisibility = () => {
		if (document.hidden) remember();
	};
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		remember();
	};
}
