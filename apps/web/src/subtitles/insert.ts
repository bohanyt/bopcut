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

	const canvasSize = editor.project.getActive().settings.canvasSize;
	const ctx = createSubtitleMeasurementContext();
	// Clips on one track cannot overlap. Rolling captions overlap the next cue a little: such a cue
	// ends where the next one starts, before its words are spread. Cues that start together (two
	// speakers) cannot be shortened that way and go to another track below.
	const cues = captions
		.map((caption, index) => ({ caption, index }))
		.filter(({ caption }) => caption.text)
		.sort((a, b) => a.caption.startTime - b.caption.startTime || a.index - b.index);
	const fitted = cues.map(({ caption, index }, at) => {
		const next = cues.slice(at + 1).find((cue) => cue.caption.startTime > caption.startTime)?.caption;
		const end = caption.startTime + caption.duration;
		return { index, caption: next && next.startTime < end ? { ...caption, duration: next.startTime - caption.startTime } : caption };
	});
	const elements = fitted
		.map(({ caption, index }) => ({ ...buildSubtitleTextElement({ index, caption, canvasSize, ctx }), id: generateUUID() }))
		.sort((a, b) => a.startTime - b.startTime);
	const textTrack = () => buildEmptyTrack({ id: generateUUID(), type: "text" });
	const tracks: { track: ReturnType<typeof textTrack>; end: number }[] = [];
	let last: { trackId: string; elementId: string } | undefined;
	for (const element of elements) {
		let lane = tracks.find(({ end }) => end <= element.startTime);
		if (!lane) {
			lane = { track: textTrack(), end: 0 };
			tracks.push(lane);
		}
		lane.track.elements.push(element);
		lane.end = element.startTime + element.duration;
		last = { trackId: lane.track.id, elementId: element.id };
	}
	if (tracks.length === 0) tracks.push({ track: textTrack(), end: 0 });

	const before = editor.scenes.getActiveScene().tracks;
	const after = { ...before, overlay: [...tracks.map(({ track }) => track), ...before.overlay] };
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before,
			after,
			selectedElements: last ? [last] : undefined,
		}),
	});

	return tracks[0].track.id;
}
