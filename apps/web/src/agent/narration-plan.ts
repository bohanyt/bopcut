import type { SourceWord } from "@/media/words";
import { playedSpan, sourceEnd } from "@/timeline/word-cuts";
import type { TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import type { FrameRate } from "opencut-wasm";
import { alignNarration, MAX_NARRATION_WORDS, narrationToken } from "./narration-alignment";
import { orderedTracks } from "./scene-graph";

const ROW_LIMIT = 1250;
const SPAN_LIMIT = 256;
const encoder = new TextEncoder();
const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;
type Anchor = { word: number; edge: "start" | "end" } |
	{ word: number; fraction: number } |
	{ pause: [number, number]; fraction: number } |
	{ word: number; leadSeconds: number };

function cap<T>(items: T[], maxRows: number, maxBytes: number) {
	const included = [];
	for (const item of items) {
		if (included.length >= maxRows) break;
		maxBytes -= encoder.encode(JSON.stringify(item)).length + 1;
		if (maxBytes < 0) break;
		included.push(item);
	}
	return { items: included, omitted: items.length - included.length };
}

function upcoming(words: SourceWord[], at: number): number {
	let lo = 0, hi = words.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (words[mid].start <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function anchorAt(words: SourceWord[], at: number, side: "start" | "end", tolerance: number, interior: boolean): Anchor | undefined {
	const i = upcoming(words, at);
	const previous = words[i - 1], next = words[i];
	const edges = [
		...(previous ? [{ word: i - 1, edge: "start" as const, delta: at - previous.start },
			{ word: i - 1, edge: "end" as const, delta: at - previous.end }] : []),
		...(next ? [{ word: i, edge: "start" as const, delta: at - next.start }] : []),
	].filter(({ delta }) => Math.abs(delta) <= tolerance).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) ||
		Number(b.edge === side) - Number(a.edge === side));
	if (edges.length) {
		if (edges[1] && edges[0].edge === edges[1].edge &&
			Math.abs(Math.abs(edges[0].delta) - Math.abs(edges[1].delta)) < 1e-9) return;
		const { word, edge } = edges[0];
		return { word, edge };
	}
	if (!interior || !previous) return;
	if (at < previous.end) return { word: i - 1, fraction: (at - previous.start) / (previous.end - previous.start) };
	if (next) return { pause: [i - 1, i], fraction: (at - previous.end) / (next.start - previous.end) };
}

function effectAnchor(words: SourceWord[], at: number): Anchor | undefined {
	const i = upcoming(words, at);
	const candidates = [i - 1, i].filter((j) => words[j] && Math.abs(at - words[j].start) <= 0.15);
	if (candidates.length !== 1) return;
	const word = candidates[0];
	return { word, leadSeconds: words[word].start - at };
}

export function planNarration({
	root, fps, clipId, mediaId, oldWords, newWords, newDuration, check,
}: {
	root: TScene; fps: FrameRate; clipId: string; mediaId: string; oldWords: SourceWord[]; newWords: SourceWord[];
	newDuration: number; check: () => void;
}) {
	const tracks = orderedTracks(root.tracks);
	if (!/^[\w-]{1,128}$/.test(root.id)) throw new Error("The saved root scene needs a valid ID.");
	const all = tracks.flatMap((track) => [...track.elements].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
		.map((element) => ({ track, element })));
	if (all.length > 10_000) throw new Error("The narration planner supports up to 10,000 clips in the root scene.");
	const selected = all.filter(({ element }) => element.id === clipId);
	const narration = selected[0]?.element;
	if (selected.length !== 1 || narration?.type !== "audio" || narration.sourceType !== "upload" ||
		(narration.retime?.rate ?? 1) !== 1 || narration.startTime < 0 || narration.duration <= 0) {
		throw new Error("Select one unretimed, uploaded audio clip in the saved root scene.");
	}
	if (all.some(({ element }) => element !== narration && element.type === "audio" &&
		element.sourceType === "upload" && element.mediaId === narration.mediaId)) {
		throw new Error("The old narration media appears in multiple root audio clips. Select a narration that uses one clip.");
	}
	if (narration.mediaId === mediaId) throw new Error("Choose a different media ID for the replacement recording.");
	if (Math.max(oldWords.length, newWords.length) > MAX_NARRATION_WORDS) throw new Error("Each transcript supports up to 5,000 words.");
	if (!Number.isFinite(newDuration) || newDuration <= 0 || newWords.some((word) => word.end > newDuration)) {
		throw new Error("The replacement needs a known duration and words within its audio.");
	}
	const rate = fps?.numerator / fps?.denominator;
	if (!Number.isFinite(rate) || rate <= 0) throw new Error("The saved project needs a valid frame rate.");
	const original = playedSpan(narration);
	const eps = 1e-9;
	if (oldWords.some((word) => [original.from, original.to].some((edge) => word.start < edge - eps && word.end > edge + eps))) {
		throw new Error("The old narration trim cuts a word. Move the cut outside the word first.");
	}
	const local = oldWords.filter((word) => word.start >= original.from - eps && word.end <= original.to + eps);
	const { matches, limited } = alignNarration(local, newWords, check);
	const origin = seconds(narration.startTime);
	const old = local.map((word) => ({ ...word, start: origin + word.start - original.from, end: origin + word.end - original.from }));
	const next = newWords.map((word) => ({ ...word, start: origin + word.start, end: origin + word.end }));
	const frame = (at: number) => Math.round(at * rate);
	if (frame(origin + newDuration) <= frame(origin)) throw new Error("The replacement is shorter than one project frame.");
	const byOld = new Map(matches.map((match) => [match.old, match]));
	const byNew = new Set(matches.map((match) => match.next));
	const wordSpan = (words: SourceWord[], start: number, end: number) => ({
		indices: [start + 1, end + 1], words: words.slice(start, end + 1).map(({ text }) => text),
		start: words[start].start, end: words[end].end,
	});
	const spans = [];
	for (let i = 0; i < matches.length;) {
		const first = matches[i++];
		let last = first;
		while (i < matches.length && last.old - first.old < 11 && matches[i].old === last.old + 1 &&
			matches[i].next === last.next + 1 && matches[i].reason === first.reason &&
			old[matches[i].old].start - old[last.old].end < 0.5 && next[matches[i].next].start - next[last.next].end < 0.5) last = matches[i++];
		spans.push({ old: wordSpan(old, first.old, last.old), next: wordSpan(next, first.next, last.next),
			shiftSeconds: next[first.next].start - old[first.old].start, confidence: first.confidence, reason: first.reason });
	}
	const missing = (words: SourceWord[], known: (i: number) => boolean) => words.flatMap((_, i) =>
		known(i) ? [] : [wordSpan(words, i, i)]);
	const unmatched = missing(old, (i) => byOld.has(i)), inserted = missing(next, (i) => byNew.has(i));
	const wordRange = (anchor: Anchor): [number, number] => "pause" in anchor ? anchor.pause : [anchor.word, anchor.word];
	const clearThrough = new Int32Array(old.length).fill(-1);
	for (let i = old.length - 1; i >= 0; i--) {
		const hit = byOld.get(i), following = byOld.get(i + 1);
		if (hit?.confidence === "high") clearThrough[i] = following?.confidence === "high" && following.next === hit.next + 1 ? clearThrough[i + 1] : i;
	}
	const clear = (start: Anchor, end: Anchor) => {
		const [first] = wordRange(start), [, last] = wordRange(end);
		return first <= last && clearThrough[first] >= last;
	};
	const mapped = (anchor: Anchor) => {
		const get = (i: number) => next[byOld.get(i)!.next];
		if ("pause" in anchor) {
			const a = get(anchor.pause[0]).end, b = get(anchor.pause[1]).start;
			return a + (b - a) * anchor.fraction;
		}
		const word = get(anchor.word);
		if ("edge" in anchor) return word[anchor.edge];
		if ("leadSeconds" in anchor) return word.start - anchor.leadSeconds;
		return word.start + (word.end - word.start) * anchor.fraction;
	};
	const key = (anchor: Anchor) => "pause" in anchor
		? { pause: anchor.pause.map((i) => i + 1), fraction: anchor.fraction }
		: { ...anchor, word: anchor.word + 1 };
	const rows = [];
	const offsets = new Map<string, number | null>();
	let humanTimingConflicts = 0;
	const totals = { move: 0, trim: 0, unchanged: 0, needsMoreSource: 0, shorterThanProtectedContent: 0, crossesUnresolvedChange: 0, unanchored: 0 };
	const tolerance = Math.min(0.04, 0.5 / rate);
	for (const { track, element } of all) {
		check();
		if (element === narration) continue;
		const start = seconds(element.startTime), duration = seconds(element.duration), end = start + duration;
		const first = upcoming(old, start - tolerance), last = upcoming(old, end - eps);
		const caption = element.type === "text" && element.caption && last > first && last - first <= 120 &&
			old.slice(first, last).map((word) => narrationToken(word.text)).join(" ") ===
				element.caption.words.map((word) => narrationToken(word.text)).join(" ");
		if (element.type === "audio" && duration > 2) { totals.unanchored++; continue; }
		const followStart = element.type === "audio" || element.type === "effect";
		const endEdge = followStart ? undefined : anchorAt(old, end, "end", tolerance, false);
		const startAnchor = (followStart ? effectAnchor(old, start) : undefined) ??
			anchorAt(old, start, "start", tolerance, !!caption || !!endEdge);
		const endAnchor = followStart ? startAnchor : endEdge ?? anchorAt(old, end, "end", tolerance, !!caption || !!startAnchor);
		if (!startAnchor || !endAnchor) { totals.unanchored++; continue; }
		const resolved = clear(startAnchor, endAnchor);
		const startFrame = resolved ? frame(mapped(startAnchor)) : null;
		const endFrame = resolved ? frame(followStart ? mapped(startAnchor) + duration : mapped(endAnchor)) : null;
		const valid = startFrame !== null && endFrame !== null && startFrame >= 0 && endFrame > startFrame;
		if (valid && startFrame === frame(start) && endFrame === frame(end)) {
			offsets.set(element.id, 0);
			totals.unchanged++;
			continue;
		}
		const proposedDuration = valid ? (endFrame - startFrame) / rate : 0;
		const fields = element.humanFields ?? [];
		const oldFrames = frame(end) - frame(start);
		const shorter = valid && endFrame - startFrame < oldFrames;
		const protectedTiming = shorter && fields.some((field) =>
			field === "duration" || field === "trimStart" || field === "retime" || field.startsWith("keyframes.") ||
			field === "caption" || field === "params.content");
		const media = element.type === "video" || element.type === "audio" || element.type === "compound";
		const speed = "retime" in element ? element.retime?.rate ?? 1 : 1;
		const kind = !valid ? "crossesUnresolvedChange" : protectedTiming ? "shorterThanProtectedContent"
			: media && proposedDuration * speed + seconds(element.trimStart) > sourceEnd(element) + 1e-9 ? "needsMoreSource"
			: endFrame - startFrame === oldFrames ? "move" : "trim";
		totals[kind]++;
		const protectedChanges = !valid ? [] : fields.filter((field) =>
			(field === "start" && startFrame !== frame(start)) ||
			(field === "duration" && endFrame - startFrame !== oldFrames));
		if (protectedChanges.length) humanTimingConflicts++;
		offsets.set(element.id, !protectedChanges.length && (kind === "move" || kind === "trim") ? startFrame! - frame(start) : null);
		if (rows.length >= ROW_LIMIT) continue;
		rows.push({ address: { sceneId: root.id, trackId: track.id, id: element.id, agentId: element.agentId ?? null, path: [] },
			track: track.name.slice(0, 120), anchor: { start: key(startAnchor), end: followStart ? null : key(endAnchor), keepDuration: followStart },
			evidence: caption ? "caption words and timing" : followStart ? "short audio or effect near a word" : "clip edge near a word",
			old: { start, end }, proposed: valid ? { startFrame, endFrame } : null, kind,
			protectedChanges,
			humanEdited: { tracked: !!element.agentId, start: fields.includes("start"), duration: fields.includes("duration"), trimStart: fields.includes("trimStart"),
				retime: fields.includes("retime"), caption: fields.includes("caption") || fields.includes("params.content"),
				keyframes: fields.some((field) => field.startsWith("keyframes.")) } });
	}
	const notes = [];
	let unanchoredNotes = 0;
	for (const note of root.bookmarks) {
		check();
		if (!note.elementIds?.some((id) => offsets.has(id))) { unanchoredNotes++; continue; }
		const shifts = note.elementIds.map((id) => offsets.get(id));
		const shift = shifts[0];
		const from = frame(seconds(note.time)), to = frame(seconds(note.time + (note.duration ?? 0)));
		const resolved = shift != null && shifts.every((value) => value === shift) && from + shift >= 0;
		if (resolved && shift === 0) continue;
		notes.push({ id: note.id ?? `legacy-${note.time}`, old: { start: seconds(note.time), end: seconds(note.time + (note.duration ?? 0)) },
			proposed: resolved ? { startFrame: from + shift, endFrame: to + shift } : null,
			reason: resolved ? "linked elements move together" : "linked elements have different or unresolved moves" });
	}
	const boundedRows = cap(rows, ROW_LIMIT, 1024 * 1024);
	return { sceneId: root.id, clipId, oldMediaId: narration.mediaId, newMediaId: mediaId, fps, limited,
		narration: { oldStart: origin, oldEnd: origin + seconds(narration.duration), startFrame: frame(origin), endFrame: frame(origin + newDuration) },
		totals: { ...totals, spans: spans.length, unmatched: unmatched.length, inserted: inserted.length, notes: notes.length,
			unanchoredNotes, humanTimingConflicts, frozen: 0 },
		spans: cap(spans, SPAN_LIMIT, 384 * 1024), unmatched: cap(unmatched, SPAN_LIMIT, 64 * 1024),
		inserted: cap(inserted, SPAN_LIMIT, 64 * 1024), notes: cap(notes, SPAN_LIMIT, 64 * 1024), elements: boundedRows.items,
		omittedElements: all.length - 1 - totals.unanchored - totals.unchanged - boundedRows.items.length };
}
