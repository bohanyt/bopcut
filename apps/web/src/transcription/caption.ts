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

	for (const segment of segments) {
		const words = segment.text.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0 || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) continue;

		const segmentDuration = segment.end - segment.start;
		const wordsPerSecond = words.length / segmentDuration;

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
