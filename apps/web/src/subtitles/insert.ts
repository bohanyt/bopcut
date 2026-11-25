import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/commands";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";
import { buildSubtitleTextElement, createSubtitleMeasurementContext } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
}): string | null {
	if (captions.length === 0) {
		return null;
	}

	const track = buildEmptyTrack({ id: generateUUID(), type: "text" });
	const canvasSize = editor.project.getActive().settings.canvasSize;
	const ctx = createSubtitleMeasurementContext();
	captions.forEach((caption, index) => {
		if (!caption.text) return;
		const element = buildSubtitleTextElement({ index, caption, canvasSize, ctx });
		track.elements.push({ ...element, id: generateUUID() });
	});

	const before = editor.scenes.getActiveScene().tracks;
	const after = { ...before, overlay: [track, ...before.overlay] };
	const last = track.elements.at(-1);
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before,
			after,
			selectedElements: last ? [{ trackId: track.id, elementId: last.id }] : undefined,
		}),
	});

	return track.id;
}
