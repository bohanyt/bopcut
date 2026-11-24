import { EditorCore } from "@/core";
import { mixTimelineAudio } from "@/media/audio-mixdown";
import { calculateTotalDuration, type CompoundElement, type TScene } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { captureFrame } from "./frames";
import { timelineTranscript } from "./packed-transcript";
import { accumulatePeaks, drawRangeView, parseRangeInput, rangeRows, RANGE_BUCKETS, RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH, type RangeSpan } from "./range-view";
import type { RenderTransport } from "./render-transport";
import { getRootScene, orderedTracks, toRootInterval } from "./scene-graph";

function visibleSpans(root: TScene, scenes: TScene[], from: number, to: number): RangeSpan[] {
	const result: RangeSpan[] = [];
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	function visit(scene: TScene, chain: CompoundElement[], seen: Set<string>) {
		if (seen.has(scene.id) || chain.length > 32) return;
		const ancestors = new Set(seen).add(scene.id);
		for (const track of orderedTracks(scene.tracks)) {
			if ("hidden" in track && track.hidden) continue;
			for (const element of track.elements) {
				if (result.length >= 1000) return;
				if ("hidden" in element && element.hidden) continue;
				const visible = toRootInterval(element.startTime, element.startTime + element.duration, chain);
				if (!visible) continue;
				const [start, end] = visible.map((ticks) => ticks / TICKS_PER_SECOND);
				if (start >= to || end <= from) continue;
				result.push({ start, end, label: element.type === "text" ? String(element.params.content ?? "") : element.name, text: element.type === "text" });
				if (element.type === "compound") {
					const nested = byId.get(element.sceneId);
					if (nested) visit(nested, [...chain, element], ancestors);
				}
			}
		}
	}
	visit(root, [], new Set());
	return result;
}

export async function renderRangeView(options: Record<string, unknown>, job: RenderTransport) {
	const input = parseRangeInput(options);
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
	drawRangeView(ctx, input, {
		title: project.metadata.name, frames: tiles.map((tile) => (x, y, w, h) => ctx.drawImage(tile, x, y, w, h)),
		peaks, words: clips.flatMap((clip) => clip.phrases).sort((a, b) => a.start - b.start),
		spans: visibleSpans(root, scenes, input.from, input.to),
	});
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("Could not create PNG.");
	signal.throwIfAborted();
	const uploaded = await job.request("/api/agent/view-file", { method: "POST", body: blob, signal });
	if (!uploaded.ok) throw new Error("Could not save the range picture.");
}
