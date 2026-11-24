import type { TranscriptionSegment, CaptionChunk } from "@/transcription/types";
import {
	DEFAULT_WORDS_PER_CAPTION,
	MIN_CAPTION_DURATION_SECONDS,
} from "@/transcription/caption-defaults";

export function buildCaptionChunks({
	segments,
	wordsPerChunk = DEFAULT_WORDS_PER_CAPTION,
	minDuration = MIN_CAPTION_DURATION_SECONDS,
}: {
	segments: TranscriptionSegment[];
	wordsPerChunk?: number;
	minDuration?: number;
}): CaptionChunk[] {
	const captions: CaptionChunk[] = [];

	const ordered = segments
		.filter((segment) => segment.text.trim() !== "" && Number.isFinite(segment.start))
		.sort((a, b) => a.start - b.start);

	for (const [i, segment] of ordered.entries()) {
		const words = segment.text.trim().split(/\s+/);
		// The model can leave the end out (it is then the start); speech goes on until the next segment.
		const next = ordered[i + 1]?.start;
		const end = segment.end > segment.start
			? segment.end
			: next !== undefined && next > segment.start ? next : segment.start + Math.max(minDuration, words.length * 0.35);
		const wordsPerSecond = words.length / (end - segment.start);

		const chunks: string[] = [];
		for (let i = 0; i < words.length; i += wordsPerChunk) {
			chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
		}

		let chunkStartTime = segment.start;
		for (const chunk of chunks) {
			const chunkWords = chunk.split(/\s+/).length;
			const chunkDuration = chunkWords / wordsPerSecond;

			captions.push({
				text: chunk,
				startTime: chunkStartTime,
				duration: chunkDuration,
			});

			chunkStartTime += chunkDuration;
		}
	}

	captions.sort((a, b) => a.startTime - b.startTime);
	const merged: CaptionChunk[] = [];
	for (const caption of captions) {
		const previous = merged.at(-1);
		if (previous && caption.startTime - previous.startTime < 1e-6) {
			previous.text = `${previous.text} ${caption.text}`;
			previous.duration = Math.max(previous.duration, caption.duration);
		} else {
			merged.push(caption);
		}
	}
	// A short caption is held for the minimum time, but never into the next one.
	return merged.map((caption, i) => {
		const room = (merged[i + 1]?.startTime ?? Infinity) - caption.startTime;
		return { ...caption, duration: Math.min(Math.max(caption.duration, minDuration), room) };
	});
}
