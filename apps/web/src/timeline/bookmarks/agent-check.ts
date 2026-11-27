import { create } from "zustand";
import type { EditorCore } from "@/core";
import type { Bookmark } from "@/timeline";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, subMediaTime, type MediaTime } from "@/wasm";
import { getFrameTime } from "./utils";

/** The note whose editor opens next, with its text selected: set by a request, cleared by the marker that opens. */
export const useRequestedNote = create<{ id: string | null }>(() => ({ id: null }));

/** The timeline time under the pointer, for an element that spans the whole timeline from its left edge. */
export function timeAtClientX({ clientX, element, zoomLevel }: { clientX: number; element: Element; zoomLevel: number }): MediaTime {
	const x = clientX - element.getBoundingClientRect().left;
	return mediaTimeFromSeconds({ seconds: Math.max(0, x / getTimelinePixelsPerSecond({ zoomLevel })) });
}

/**
 * Asks the agent to check a moment or a clip: a note at that frame, which the agent
 * reads with the other notes, opened so the person can say what to look at. A note
 * already at that frame is opened as it is. Returns the note's ID.
 */
export function requestAgentCheck({
	editor,
	time,
	duration,
	elementIds,
	note,
}: {
	editor: EditorCore;
	time: MediaTime;
	duration?: MediaTime;
	elementIds?: string[];
	note: string;
}): string | null {
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!project || !scene || editor.timeline.getTotalDuration() <= 0) return null;
	const lastFrame = editor.timeline.getLastFrameTime();
	const frame = getFrameTime({ time: time > lastFrame ? lastFrame : time, fps: project.settings.fps });
	const existing = scene.bookmarks.find((bookmark) => bookmark.time === frame);

	if (existing?.note) {
		const id = existing.id ?? generateUUID();
		if (!existing.id) editor.scenes.updateBookmark({ time: frame, bookmark: existing, updates: { id } });
		useRequestedNote.setState({ id });
		return id;
	}

	const id = existing?.id ?? generateUUID();
	const room = subMediaTime({ a: editor.timeline.getTotalDuration(), b: frame });
	const updates: Partial<Omit<Bookmark, "time">> = {
		id,
		note,
		author: "user",
		resolved: false,
		createdAt: new Date().toISOString(),
		...(elementIds?.length ? { elementIds } : {}),
		...(duration !== undefined && duration > 0 ? { duration: duration < room ? duration : room } : {}),
	};
	editor.scenes.updateBookmark({ time: frame, updates, create: !existing, bookmark: existing });
	useRequestedNote.setState({ id });
	return id;
}
