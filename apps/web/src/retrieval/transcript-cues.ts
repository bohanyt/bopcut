export type Span = { start: number; end: number };
type Word = Span & { text: string };
export type Cue = Word & { words?: Word[] };
type Segment = { utf8: string; tOffsetMs?: number };
type CaptionEvent = { tStartMs: number; dDurationMs: number; segs?: Segment[]; aAppend?: number };
type Counts = { empty: number; invalid: number; untimed: number };
const noise = /^(?:\s|\[(?:music|applause|laughter|noise|silence|inaudible|cheering)\]|[♪♫♬♩])+$/i;

function addWords(cue: Cue, parts: { text: string; start: number }[], counts: Counts) {
	const words = parts.filter(({ text }) => text);
	if (words.some(({ start }, i) => !Number.isFinite(start) || start < (words[i - 1]?.start ?? cue.start) || start > cue.end)) {
		counts.untimed++;
	} else if (words.length) {
		cue.words = words.map((word, i) => ({ ...word, end: words[i + 1]?.start ?? cue.end }));
	}
}

function jsonCues(data: string, auto: boolean, counts: Counts): Cue[] {
	const events = JSON.parse(data)?.events;
	if (!Array.isArray(events)) return [];
	const timed = (events as CaptionEvent[]).flatMap((event) => {
		if (!Array.isArray(event?.segs)) return [];
		const segments = event.segs.filter((segment) => typeof segment?.utf8 === "string");
		const text = segments.map(({ utf8 }) => utf8).join("");
		if (auto && event.aAppend === 1 && !text.trim()) return [];
		const { tStartMs, dDurationMs } = event;
		if (!Number.isFinite(tStartMs) || !Number.isFinite(dDurationMs) || tStartMs < 0 || dDurationMs < 0) {
			if (text.trim()) counts.invalid++;
			else counts.empty++;
			return [];
		}
		return [{ start: tStartMs / 1000, end: (tStartMs + dDurationMs) / 1000, tStartMs, text, segments }];
	}).sort((a, b) => a.start - b.start);
	return timed.flatMap(({ start, end, tStartMs, text, segments }, i) => {
		if (!text.trim()) { counts.empty++; return []; }
		const cue = { start, end: auto ? Math.min(end, timed[i + 1]?.start ?? end) : end, text };
		if (segments.every(({ tOffsetMs }) => typeof tOffsetMs === "number")) {
			addWords(cue, segments.map(({ utf8, tOffsetMs }) => ({
				text: utf8.trim(), start: (tStartMs + tOffsetMs!) / 1000,
			})), counts);
		}
		return [cue];
	});
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "\u200e", rlm: "\u200f", quot: '"', apos: "'" };
const timestamp = "(?:\\d{2,}:)?[0-5]\\d:[0-5]\\d\\.\\d{3}";
const timing = new RegExp("^(" + timestamp + ")[ \\t]+-->[ \\t]+(" + timestamp + ")(?:[ \\t].*)?$");
const inlineTime = new RegExp("<(" + timestamp + ")>", "g");
const vttSeconds = (s: string) => s.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
const vttText = (text: string) => text.replace(/<[^>]*>/g, "")
	.replace(/&([a-z]+);/g, (entity, name: string) => Object.hasOwn(entities, name) ? entities[name] : entity);

function vttCues(data: string, counts: Counts): Cue[] {
	if (!/^\uFEFF?WEBVTT(?:[ \t]|\r|\n|$)/.test(data)) return [];
	return data.replace(/\r\n?/g, "\n").split(/\n(?:[ \t]*\n)+/).slice(1).flatMap((block) => {
		const lines = block.split("\n");
		if (/^NOTE(?:\s|$)/.test(lines[0])) return [];
		const index = lines[0].includes("-->") ? 0 : lines[1]?.includes("-->") ? 1 : -1;
		if (index < 0 && /^(STYLE|REGION)[ \t]*$/.test(lines[0])) return [];
		const raw = lines.slice(index + 1).join("\n");
		const text = vttText(raw).trim();
		const match = timing.exec(lines[index] ?? "");
		if (!match) {
			if (text) counts.invalid++;
			return [];
		}
		if (!text) { counts.empty++; return []; }
		const cue = { start: vttSeconds(match[1]), end: vttSeconds(match[2]), text };
		if (!Number.isFinite(cue.end) || cue.end <= cue.start) { counts.invalid++; return []; }
		const pieces = raw.split(inlineTime);
		if (pieces.length > 1) {
			addWords(cue, pieces.flatMap((piece, i) => i % 2 ? [] : [{
				text: vttText(piece).trim(), start: i === 0 ? cue.start : vttSeconds(pieces[i - 1]),
			}]), counts);
		}
		return [cue];
	});
}

export function parseCaptions(data: string, format: "json3" | "vtt", auto: boolean, duration?: number) {
	const counts: Counts = { empty: 0, invalid: 0, untimed: 0 };
	const cues = format === "json3" ? jsonCues(data, auto, counts) : vttCues(data, counts);
	const warnings: string[] = [];
	const sound = cues.filter((cue) => noise.test(cue.text)).length;
	const outOfRange = duration === undefined ? 0 : cues.filter((cue) => cue.end > duration).length;
	if (counts.empty) warnings.push("Dropped " + counts.empty + " empty caption cues.");
	if (counts.invalid) warnings.push("Dropped " + counts.invalid + " caption cues with invalid timing.");
	if (counts.untimed) warnings.push("Omitted invalid word times in " + counts.untimed + " caption cues.");
	if (sound) warnings.push("Kept " + sound + " music or sound-effect-only caption cues.");
	if (outOfRange) warnings.push("Found " + outOfRange + " caption cues outside the video duration.");
	if (auto && cues.length) {
		if (format === "vtt") warnings.push("automatic VTT captions can repeat lines");
		warnings.push("Auto caption timings can be off by a few seconds; verify openings with frames or audio before cutting.");
	}
	return { cues, warnings };
}
