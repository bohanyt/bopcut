import type { ParseSubtitleResult, SubtitleCue } from "./types";

const TIMESTAMP = String.raw`\d+:\d{2}:\d{2}[,.]\d{1,3}`;
// Positioning may follow the end time (`position:50% line:90%`, legacy `X1:… Y2:…`); it is ignored.
const TIMESTAMP_PATTERN = new RegExp(String.raw`^(${TIMESTAMP})\s*-->\s*(${TIMESTAMP})(?:\s+.*)?$`);
const INDEX_PATTERN = /^\d+$/;

/**
 * Reads SubRip line by line: a timestamp line starts a cue, an index line right before one is dropped, and
 * text runs until a blank line or the next cue, so files that omit blank lines or index lines still split.
 */
export function parseSrt({ input }: { input: string }): ParseSubtitleResult {
	const normalized = input.replace(/\r\n?/g, "\n").trim();
	if (!normalized) {
		return {
			captions: [],
			skippedCueCount: 0,
			warnings: [],
		};
	}

	const lines = normalized.split("\n").map((line) => line.trim());
	const cues: SubtitleCue[] = [];
	let skippedCueCount = 0;
	let current: { start: string; end: string; text: string[] } | null = null;
	// Lines outside any cue (a block without a valid timestamp) count as one skipped cue per block.
	let stray = false;

	const finishCue = () => {
		if (!current) return;
		const cue = current;
		current = null;
		const text = cue.text.join("\n").trim();
		const startTime = parseSrtTimestamp({ input: cue.start });
		const endTime = parseSrtTimestamp({ input: cue.end });
		const duration = endTime - startTime;
		if (!text || !Number.isFinite(startTime) || !Number.isFinite(endTime) || duration <= 0) {
			skippedCueCount += 1;
			return;
		}
		cues.push({ text, startTime, duration });
	};
	const finishStray = () => {
		if (stray) skippedCueCount += 1;
		stray = false;
	};

	for (const [index, line] of lines.entries()) {
		if (!line) {
			finishCue();
			finishStray();
			continue;
		}
		const timestamp = line.match(TIMESTAMP_PATTERN);
		if (timestamp) {
			finishCue();
			finishStray();
			current = { start: timestamp[1], end: timestamp[2], text: [] };
			continue;
		}
		if (INDEX_PATTERN.test(line) && TIMESTAMP_PATTERN.test(lines[index + 1] ?? "")) {
			finishCue();
			finishStray();
			continue;
		}
		if (current) current.text.push(line);
		else stray = true;
	}
	finishCue();
	finishStray();

	return {
		captions: cues,
		skippedCueCount,
		warnings: [],
	};
}

function parseSrtTimestamp({ input }: { input: string }): number {
	const normalized = input.trim().replace(",", ".");
	const match = normalized.match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/);
	if (!match) {
		return Number.NaN;
	}

	const [, hours, minutes, seconds, milliseconds] = match;
	const parsedHours = Number.parseInt(hours, 10);
	const parsedMinutes = Number.parseInt(minutes, 10);
	const parsedSeconds = Number.parseInt(seconds, 10);
	const parsedMilliseconds = Number.parseInt(milliseconds, 10);

	return (
		parsedHours * 3600 +
		parsedMinutes * 60 +
		parsedSeconds +
		parsedMilliseconds / 1000
	);
}
