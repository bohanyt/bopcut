import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/commands";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";
import { buildSubtitleTextElement, createSubtitleMeasurementContext } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
	sceneId = editor.scenes.getActiveSceneOrNull()?.id,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
	sceneId?: string;
}): string | null {
	const scene = editor.scenes.getScenes().find(({ id }) => id === sceneId);
	if (!scene || captions.length === 0) {
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

	const before = scene.tracks;
	const after = { ...before, overlay: [track, ...before.overlay] };
	const last = track.elements.at(-1);
	const isActive = scene.id === editor.scenes.getActiveSceneOrNull()?.id;
	editor.command.execute({
		sceneId: scene.id,
		command: new TracksSnapshotCommand({
			before,
			after,
			sceneId: scene.id,
			ripples: isActive,
			selectedElements: last ? [{ trackId: track.id, elementId: last.id }] : undefined,
		}),
	});

	return track.id;
}
