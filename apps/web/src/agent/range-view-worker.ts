import { EditorCore } from "@/core";
import { loadFonts } from "@/fonts/google-fonts";
import { mixTimelineAudio } from "@/media/audio-mixdown";
import { calculateTotalDuration } from "@/timeline";
import { waitWithAbort } from "@/utils/abort";
import { lastFrameMediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { captureFrame } from "./frames";
import { timelineTranscript } from "./packed-transcript";
import { accumulatePeaks, drawRangeView, rangeRows, RANGE_BUCKETS, RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH, type RangeInput, type RangeSpan } from "./range-view";
import { rangeFontFamilies, visibleRangeElements } from "./range-view-project";
import type { RenderTransport } from "./render-transport";
import { getRootScene } from "./scene-graph";

export async function renderRangeView(input: RangeInput, job: RenderTransport) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActive();
	const scenes = editor.scenes.getScenes();
	const root = getRootScene(scenes, editor.scenes.getActiveSceneOrNull()?.id ?? null);
	const assets = editor.media.getAssets();
	if (!root) throw new Error("No timeline was saved for this project.");
	const duration = calculateTotalDuration({ tracks: root.tracks });
	if (input.to > duration / TICKS_PER_SECOND + 1e-9) throw new Error("The range ends outside the saved timeline.");
	if (editor.media.getMissingMedia().length) throw new Error("Some stored media are missing. Restore them before making a range view.");
	const signal = AbortSignal.any([editor.project.getSessionSignal(), ...(job.signal ? [job.signal] : [])]);
	await waitWithAbort(loadFonts({ families: rangeFontFamilies(root, scenes, input) }), signal);
	const last = lastFrameMediaTime({ duration, fps: project.settings.fps });
	const tiles: HTMLCanvasElement[] = [];
	for (const [index, row] of rangeRows(input).entries()) {
		job.reportStage?.(`rendering frame ${index + 1}/${input.rows}`);
		const time = mediaTimeFromSeconds({ seconds: row.time });
		const image = await captureFrame({ ticks: time > last ? last : time, scenes, sceneId: root.id, settings: project.settings, signal });
		try {
			const tile = document.createElement("canvas");
			tile.width = RANGE_FRAME_WIDTH;
			tile.height = 91;
			const context = tile.getContext("2d")!;
			const scale = Math.min(tile.width / image.width, tile.height / image.height);
			const w = image.width * scale, h = image.height * scale;
			context.fillStyle = "#080c13";
			context.fillRect(0, 0, tile.width, tile.height);
			context.drawImage(image, (tile.width - w) / 2, (tile.height - h) / 2, w, h);
			tiles.push(tile);
		} finally { image.close(); }
	}
	job.reportStage?.("mixing range audio");
	const sampleRate = 12_000;
	const peaks = new Float32Array(input.rows * RANGE_BUCKETS);
	const samples = Math.ceil(input.to * sampleRate) - Math.floor(input.from * sampleRate);
	let offset = 0;
	for await (const block of mixTimelineAudio({ tracks: root.tracks, scenes, mediaAssets: assets,
		duration: mediaTimeFromSeconds({ seconds: input.to }), rangeStart: mediaTimeFromSeconds({ seconds: input.from }), sampleRate, signal })) {
		for (let channel = 0; channel < block.numberOfChannels; channel++) {
			accumulatePeaks(peaks, block.getChannelData(channel), offset, samples);
		}
		offset += block.length;
	}
	const clips = timelineTranscript(root, scenes, assets, { from: input.from, to: input.to, groupWords: false });
	const canvas = document.createElement("canvas");
	canvas.width = RANGE_WIDTH;
	canvas.height = RANGE_HEADER + RANGE_ROW_HEIGHT * input.rows;
	const ctx = canvas.getContext("2d")!;
	const spans: RangeSpan[] = [];
	for (const { element, start, end } of visibleRangeElements(root, scenes, input)) {
		spans.push({ start, end, label: element.type === "text" ? String(element.params.content ?? "") : element.name, text: element.type === "text" });
		if (spans.length === 1000) break;
	}
	drawRangeView(ctx, input, {
		title: project.metadata.name, frames: tiles.map((tile) => (x, y, w, h) => ctx.drawImage(tile, x, y, w, h)),
		peaks, words: clips.flatMap((clip) => clip.phrases).sort((a, b) => a.start - b.start),
		spans,
	});
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("Could not create PNG.");
	signal.throwIfAborted();
	const uploaded = await job.request("/api/agent/view-file", { method: "POST", body: blob, signal });
	if (!uploaded.ok) throw new Error("Could not save the range picture.");
}
