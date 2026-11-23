export type Span = { start: number; end: number };
type Word = Span & { text: string };
export type Cue = Word & { words?: Word[] };
type Segment = { utf8: string; tOffsetMs?: number };
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const noise = /^(?:\s|\[(?:music|applause|laughter|noise|silence|inaudible|cheering)\]|[♪♫♬♩])+$/i;

function attachWords(cue: Cue, texts: string[], starts: number[]) {
	if (texts.join(" ") !== cue.text || !texts.every((text, i) =>
		text && !/\s/.test(text) && starts[i] >= (starts[i - 1] ?? cue.start) && starts[i] < cue.end)) return cue;
	cue.words = texts.map((text, i) => ({ text, start: starts[i], end: starts[i + 1] ?? cue.end }));
	return cue;
}

function jsonCues(data: string): Cue[] {
	const events = JSON.parse(data)?.events;
	if (!Array.isArray(events)) return [];
	return events.flatMap((event) => {
		if (!Array.isArray(event?.segs)) return [];
		const segments = (event.segs as Segment[]).filter((s) => typeof s?.utf8 === "string");
		const { tStartMs: time, dDurationMs: duration } = event;
		const cue: Cue = { start: time / 1000, end: (time + duration) / 1000, text: clean(segments.map((s) => s.utf8).join("")) };
		const spoken = segments.filter((s) => clean(s.utf8));
		if (spoken.some((s) => typeof s.tOffsetMs === "number")) {
			attachWords(cue, spoken.map((s) => clean(s.utf8)),
				spoken.map((s, i) => (time + (s.tOffsetMs ?? (i === 0 ? 0 : NaN))) / 1000));
		}
		return [cue];
	});
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "\u200e", rlm: "\u200f", quot: '"', apos: "'" };
const timestamp = "(?:\\d{2,}:)?[0-5]\\d:[0-5]\\d\\.\\d{3}";
const timing = new RegExp(`^(${timestamp})[ \t]+-->[ \t]+(${timestamp})(?:[ \t].*)?$`);
const inlineTime = new RegExp(`<(${timestamp})>`, "g");
const vttSeconds = (s: string) => s.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
const vttText = (text: string) => text.replace(/<[^>]*>/g, "")
	.replace(/&([a-z]+);/g, (entity, name: string) => entities[name] ?? entity);

function vttCues(data: string): Cue[] {
	if (!/^\uFEFF?WEBVTT(?:[ \t]|\r?\n|$)/.test(data)) return [];
	return data.split(/\r?\n[ \t]*\r?\n/).slice(1).flatMap((block) => {
		const lines = block.trim().split(/\r?\n/);
		if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) return [];
		const index = lines[0].includes("-->") ? 0 : 1;
		const match = timing.exec(lines[index] ?? "");
		if (!match) return [];
		const raw = lines.slice(index + 1).join("\n");
		const cue = { start: vttSeconds(match[1]), end: vttSeconds(match[2]), text: clean(vttText(raw)) };
		const pieces = raw.split(inlineTime);
		if (pieces.length === 1) return [cue];
		const chunks = pieces.filter((_, i) => i % 2 === 0).map((part) => clean(vttText(part)));
		const starts = [cue.start, ...pieces.filter((_, i) => i % 2 === 1).map(vttSeconds)];
		if (!chunks[0]) { chunks.shift(); starts.shift(); }
		return [attachWords(cue, chunks, starts)];
	});
}

function overlap(previous: Cue, next: Cue, prefix: string[], suffix: string[], format: "json3" | "vtt") {
	// Rolling VTT can insert a near-zero-length echo between two adjacent display windows.
	const echo = format === "vtt" && Math.min(previous.end - previous.start, next.end - next.start) <= 0.05;
	if (next.start >= previous.end && !(echo && next.start - previous.end <= 0.05)) return 0;
	for (let count = Math.min(suffix.length, prefix.length); count > 0; count--) {
		if (prefix.slice(0, count).join(" ") !== suffix.slice(-count).join(" ")) continue;
		if (previous.words && next.words) {
			const starts = previous.words.slice(-count);
			if (next.words.slice(0, count).some((word, i) => Math.abs(word.start - starts[i].start) > 0.01)) continue;
		}
		return count;
	}
	return 0;
}

export function parseCaptions(data: string, format: "json3" | "vtt", auto: boolean, duration?: number) {
	const cues: Cue[] = [];
	const warnings: string[] = [];
	let dropped = 0, badTimes = 0;
	let previous: Cue | undefined;
	for (const cue of (format === "json3" ? jsonCues(data) : vttCues(data)).sort((a, b) => a.start - b.start)) {
		if (!cue.text || noise.test(cue.text)) { dropped++; continue; }
		if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) {
			badTimes++;
			continue;
		}
		if (duration !== undefined && cue.end > duration) badTimes++;
		const tokens = cue.text.split(" ");
		const count = auto && previous ? overlap(previous, cue, tokens, previous.text.split(" "), format) : 0;
		previous = cue;
		if (count === tokens.length) continue;
		if (!count) { cues.push(cue); continue; }
		const words = cue.words?.slice(count);
		cues.push({ ...cue, text: tokens.slice(count).join(" "), ...(words && { words, start: words[0].start }) });
	}
	if (dropped) warnings.push(`Dropped ${dropped} empty or noise-only caption cues.`);
	if (badTimes) warnings.push(`Found ${badTimes} caption cues with invalid or out-of-range times.`);
	if (auto) warnings.push("Auto caption timings can be off by a few seconds; verify openings with frames or audio before cutting.");
	return { cues, warnings };
}
