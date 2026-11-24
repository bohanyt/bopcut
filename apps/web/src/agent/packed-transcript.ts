import { parseSourceWords, type SourceWord } from "@/media/words";
import { getEffectiveRateAt } from "@/retime/resolve";
import { isSourceAudioEnabled } from "@/timeline/audio-separation";
import { isElementMuted } from "@/timeline/audio-state";
import { expandCompoundAudioTracks } from "@/timeline/compound";
import type { TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks } from "./scene-graph";

export type TranscriptMedia = {
	id: string; name: string; duration?: number; hasAudio?: boolean; words?: SourceWord[];
};
export type Phrase = { start: number; end: number; sourceStart: number; sourceEnd: number; text: string };
export type TranscriptClip = { id: string; name: string; media: string; start: number; end: number;
	sourceStart: number; sourceEnd: number; known: boolean; phrases: Phrase[] };
export const PHRASE_GAP = 0.5;
const text = (value: string) => value.replace(/\s+/g, " ").trim();

export function mapPhrases(words: SourceWord[], start: number, end: number, sourceStart: number, rate = 1, groupWords = true): Phrase[] {
	const phrases: Phrase[] = [];
	const sourceEnd = sourceStart + (end - start) * rate;
	for (const word of words) {
		if (word.start >= sourceEnd) break;
		if (word.end <= sourceStart) continue;
		const label = text(word.text);
		if (!label) continue;
		const a = Math.max(sourceStart, word.start);
		const b = Math.min(sourceEnd, word.end);
		const at = start + (a - sourceStart) / rate;
		const until = start + (b - sourceStart) / rate;
		const previous = phrases.at(-1);
		if (groupWords && previous && at - previous.end < PHRASE_GAP - 1e-9) {
			previous.end = Math.max(previous.end, until);
			previous.sourceEnd = Math.max(previous.sourceEnd, b);
			previous.text += " " + label;
		} else {
			phrases.push({ start: at, end: until, sourceStart: a, sourceEnd: b, text: label });
		}
	}
	return phrases;
}

const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;

export function timelineTranscript(root: TScene, scenes: TScene[], media: readonly TranscriptMedia[], {
	from = 0, to = Infinity, groupWords = true,
}: { from?: number; to?: number; groupWords?: boolean } = {}): TranscriptClip[] {
	const assets = new Map(media.map((asset) => [asset.id, asset]));
	const words = new Map<string, SourceWord[]>();
	const result: TranscriptClip[] = [];
	for (const track of orderedTracks(expandCompoundAudioTracks({ tracks: root.tracks, scenes }))) {
		if ("muted" in track && track.muted) continue;
		for (const element of track.elements) {
			if ((element.type !== "video" && element.type !== "audio") || isElementMuted({ element })) continue;
			const asset = "mediaId" in element ? assets.get(element.mediaId) : undefined;
			if (element.type === "video" && (asset?.hasAudio === false || !isSourceAudioEnabled({ element }))) continue;
			const start = Math.max(from, seconds(element.startTime));
			const end = Math.min(to, seconds(element.startTime + element.duration));
			if (end <= start) continue;
			const rate = getEffectiveRateAt({ retime: element.retime });
			const sourceStart = seconds(element.trimStart) + (start - seconds(element.startTime)) * rate;
			if (asset && !words.has(asset.id)) words.set(asset.id, parseSourceWords(asset.words) ?? []);
			const knownWords = asset ? words.get(asset.id) ?? [] : [];
			result.push({ id: element.id, name: element.name, media: asset?.name ?? element.name,
				start, end, sourceStart, sourceEnd: sourceStart + (end - start) * rate,
				known: knownWords.length > 0, phrases: mapPhrases(knownWords, start, end, sourceStart, rate, groupWords) });
		}
	}
	return result.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sourceTranscript(media: TranscriptMedia): TranscriptClip {
	const words = parseSourceWords(media.words) ?? [];
	const end = Math.max(media.duration ?? 0, words.reduce((maximum, word) => Math.max(maximum, word.end), 0));
	return { id: media.id, name: media.name, media: media.name, start: 0, end, sourceStart: 0, sourceEnd: end,
		known: words.length > 0, phrases: mapPhrases(words, 0, end, 0) };
}

const MAX_BYTES = 19_500;
const fmt = (second: number) => Number(second.toFixed(2)).toString();
const interval = (start: number, end: number) => `${fmt(start)}-${fmt(end)}`;

/** Stable text with a bounded UTF-8 size. Each clip label is emitted only once. */
export function packTranscript(clips: TranscriptClip[], mode: "timeline" | "source", end: number): string {
	const heading = mode === "timeline"
		? "# timeline seconds | source seconds | preceding gap | clip | known words"
		: "# source seconds | preceding gap | media | known words";
	const events: { at: number; clip: number; phrase?: Phrase }[] = [];
	const mediaCounts = new Map<string, number>();
	const mediaLabels = new Map<string, string>();
	clips.forEach((clip, index) => {
		events.push({ at: clip.start, clip: index });
		if (clip.media !== clip.name) mediaCounts.set(clip.media, (mediaCounts.get(clip.media) ?? 0) + 1);
		for (const phrase of clip.phrases) events.push({ at: phrase.start, clip: index, phrase });
	});
	events.sort((a, b) => a.at - b.at || a.clip - b.clip);
	const lines = [heading];
	const encoder = new TextEncoder();
	let size = encoder.encode(heading).length + 1;
	let spokenEnd = 0;
	const append = (line: string) => {
		size += encoder.encode(line).length + 1;
		if (size >= MAX_BYTES - 100) return false;
		lines.push(line);
		return true;
	};
	for (const { clip, phrase } of events) {
		const label = `#${clip + 1}`;
		const item = clips[clip];
		if (phrase) {
			const source = mode === "timeline" ? `|${interval(phrase.sourceStart, phrase.sourceEnd)} ` : "";
			if (!append(`${interval(phrase.start, phrase.end)} ${source}+${fmt(Math.max(0, phrase.start - spokenEnd))} ${label} ${phrase.text}`)) break;
			spokenEnd = Math.max(spokenEnd, phrase.end);
			continue;
		}
		let media = item.name === item.media ? "" : ` (${text(item.media)})`;
		if (media && (mediaCounts.get(item.media) ?? 0) > 1) {
			let reference = mediaLabels.get(item.media);
			if (!reference) {
				reference = `@${mediaLabels.size + 1}`;
				mediaLabels.set(item.media, reference);
				if (!append(`${reference} ${text(item.media)}`)) break;
			}
			media = " " + reference;
		}
		const source = mode === "timeline" ? ` |${interval(item.sourceStart, item.sourceEnd)}` : "";
		const coverage = !item.known ? " [no words stored]" : !item.phrases.length ? " [no known words in this span]" : "";
		if (!append(`${label} ${interval(item.start, item.end)}${source} ${text(item.name)}${media}${coverage}`)) break;
	}
	if (size < MAX_BYTES - 100) {
		if (end > spokenEnd) append(`# No known words ${interval(spokenEnd, end)}`);
		if (!clips.length) append("# No audible clips.");
	}
	if (size >= MAX_BYTES - 100) lines.push("# Truncated at the output size limit.");
	return lines.join("\n") + "\n";
}
