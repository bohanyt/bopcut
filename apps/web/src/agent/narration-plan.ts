import type { SourceWord } from "@/media/words";
import { cutWarnings, playedSpan, sourceEnd, WORD_TOLERANCE } from "@/timeline/word-cuts";
import type { TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import type { FrameRate } from "opencut-wasm";
import { alignNarration, MAX_NARRATION_WORDS, narrationToken, narrationWords } from "./narration-alignment";
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
	const earlier = words[i - 2];
	const edges = [
		...(previous ? [{ word: i - 1, edge: "start" as const, delta: at - previous.start },
			{ word: i - 1, edge: "end" as const, delta: at - previous.end }] : []),
		...(next ? [{ word: i, edge: "start" as const, delta: at - next.start }] : []),
		...(earlier ? [{ word: i - 2, edge: "end" as const, delta: at - earlier.end }] : []),
	].filter(({ delta }) => Math.abs(delta) <= tolerance).sort((a, b) =>
		Number(b.edge === side) - Number(a.edge === side) || Math.abs(a.delta) - Math.abs(b.delta));
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
	root, fps, clipId, mediaId, oldWords, newWords, newDuration, check, from = 0, to = Infinity, includeUnchanged = false,
}: {
	root: TScene; fps: FrameRate; clipId: string; mediaId: string; oldWords: SourceWord[]; newWords: SourceWord[];
	newDuration: number; check: () => void; from?: number; to?: number; includeUnchanged?: boolean;
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
	if (cutWarnings(narration, oldWords).length) {
		throw new Error("The old narration trim cuts a word. Move the cut outside the word first.");
	}
	const local = narrationWords(oldWords.filter((word) => {
		const midpoint = (word.start + word.end) / 2;
		return word.end - word.start <= WORD_TOLERANCE + eps
			? midpoint >= original.from && midpoint < original.to
			: Math.min(word.end, original.to) - Math.max(word.start, original.from) > WORD_TOLERANCE + eps;
	})
		.map((word) => ({ ...word, start: Math.max(word.start, original.from), end: Math.min(word.end, original.to) })));
	if (local.length === 0) {
		throw new Error("The old narration clip plays no transcribed words. Widen its trim or transcribe the played part first.");
	}
	newWords = narrationWords(newWords);
	const { matches, limited } = alignNarration(local, newWords, check);
	const origin = seconds(narration.startTime);
	const old = local.map((word) => ({ ...word, start: origin + word.start - original.from, end: origin + word.end - original.from }));
	const next = newWords.map((word) => ({ ...word, start: origin + word.start, end: origin + word.end }));
	const frame = (at: number) => Math.round(at * rate);
	const inRange = ({ start, end }: { start: number; end: number }) => start < to && (end > from || (end === start && start >= from));
	if (frame(origin + newDuration) <= frame(origin)) throw new Error("The replacement is shorter than one project frame.");
	const byOld = new Map(matches.map((match) => [match.old, match]));
	const byNew = new Set(matches.map((match) => match.next));
	const wordSpan = (words: SourceWord[], start: number, end: number) => ({
		indices: [start + 1, end + 1], words: words.slice(start, end + 1).map(({ text }) => text),
		start: words[start].start, end: words[end].end,
	});
	const spans = [];
	const visibleMatch = (match: typeof matches[number]) => inRange(old[match.old]) || inRange(next[match.next]);
	for (let i = 0; i < matches.length;) {
		const first = matches[i++];
		if (!visibleMatch(first)) continue;
		let last = first;
		while (i < matches.length && visibleMatch(matches[i]) && last.old - first.old < 11 && matches[i].old === last.old + 1 &&
			matches[i].next === last.next + 1 && matches[i].reason === first.reason &&
			old[matches[i].old].start - old[last.old].end < 0.5 && next[matches[i].next].start - next[last.next].end < 0.5) last = matches[i++];
		const oldSpan = wordSpan(old, first.old, last.old), nextSpan = wordSpan(next, first.next, last.next);
		spans.push({ old: oldSpan, next: nextSpan,
			shiftSeconds: next[first.next].start - old[first.old].start, confidence: first.confidence, reason: first.reason });
	}
	const missing = (words: SourceWord[], known: (i: number) => boolean) => words.flatMap((_, i) =>
		known(i) || !inRange(words[i]) ? [] : [wordSpan(words, i, i)]);
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
	const pauseAllocation = (anchor: Anchor) => "pause" in anchor ? "split by original fraction"
		: "edge" in anchor ? anchor.edge === "end" ? "right clip" : "left clip" : "inside a word";
	const rows = [];
	const offsets = new Map<string, number | null>();
	let humanTimingConflicts = 0;
	const totals = { move: 0, trim: 0, unchanged: 0, needsMoreSource: 0, shorterThanProtectedContent: 0, crossesUnresolvedChange: 0, unanchored: 0 };
	const tolerance = Math.min(0.04, 0.5 / rate);
	const mainStarts = new Set<number>(root.tracks.main.elements.map((element) => element.startTime));
	const cuts = new Map<number, Anchor | undefined>();
	for (const element of root.tracks.main.elements) {
		const at = element.startTime + element.duration;
		// Prefer the left clip's last word, giving any additional pause to the right clip.
		if (mainStarts.has(at)) cuts.set(at, anchorAt(old, seconds(at), "end", tolerance, true));
	}
	const proposal = (element: TimelineElement, main: boolean): {
		start: number; end: number; startAnchor?: Anchor; endAnchor?: Anchor; startFrame?: number | null; endFrame?: number | null;
		followStart: boolean; caption: boolean; sharedStart: boolean; sharedEnd: boolean;
	} => {
		check();
		const start = seconds(element.startTime), duration = seconds(element.duration), endTicks = element.startTime + element.duration, end = seconds(endTicks);
		const first = upcoming(old, start - tolerance), last = upcoming(old, end - eps);
		const caption = element.type === "text" && element.caption && last > first && last - first <= 120 &&
			old.slice(first, last).map((word) => narrationToken(word.text)).join(" ") ===
				narrationWords(element.caption.words).map((word) => narrationToken(word.text)).join(" ");
		if (element.type === "audio" && duration > 2) return { start, end, followStart: false, caption: false, sharedStart: false, sharedEnd: false };
		const followStart = element.type === "audio" || element.type === "effect";
		const endEdge = followStart ? undefined : anchorAt(old, end, "end", tolerance, false);
		const ownStart = (followStart ? effectAnchor(old, start) : undefined) ??
			anchorAt(old, start, "start", tolerance, !!caption || !!endEdge);
		const ownEnd = followStart ? ownStart : endEdge ?? anchorAt(old, end, "end", tolerance, !!caption || !!ownStart);
		const sharedStart = main && cuts.has(element.startTime), sharedEnd = main && cuts.has(endTicks);
		const cutStart = sharedStart ? cuts.get(element.startTime) : undefined;
		const cutEnd = sharedEnd ? cuts.get(endTicks) : undefined;
		// A shared cut without an anchor lies outside the narration and stays where it is.
		const startAnchor = sharedStart ? cutStart : ownStart, endAnchor = sharedEnd ? cutEnd : ownEnd;
		const info = { start, end, startAnchor, endAnchor, followStart, caption: !!caption, sharedStart, sharedEnd };
		if (!(startAnchor && endAnchor) && !cutStart && !cutEnd) return info;
		const resolved = (!startAnchor || !endAnchor || clear(startAnchor, endAnchor)) && (!ownStart || !ownEnd || clear(ownStart, ownEnd));
		const oldFrames = frame(end) - frame(start);
		const map = (anchor: Anchor | undefined, fixed: number) =>
			anchor ? clear(anchor, anchor) ? frame(mapped(anchor)) : null : frame(fixed);
		const startFrame = resolved ? map(startAnchor, start) : null;
		const endFrame = startFrame === null ? null : followStart ? startFrame + oldFrames : map(endAnchor, end);
		return { ...info, startFrame, endFrame };
	};
	const mainPlans = root.tracks.main.elements.map((element) => ({ element, plan: proposal(element, true) }));
	const byBoundary = new Map<number, number[]>();
	for (const [i, { element }] of mainPlans.entries()) {
		for (const at of [element.startTime, element.startTime + element.duration]) {
			const anchor = cuts.get(at);
			if (!anchor || !clear(anchor, anchor) || frame(mapped(anchor)) === frame(seconds(at))) continue;
			const neighbours = byBoundary.get(at) ?? [];
			neighbours.push(i);
			byBoundary.set(at, neighbours);
		}
	}
	// If either side cannot follow a moved cut, report the whole connected set as a decision.
	const blocked = new Set<number>();
	const queue = mainPlans.flatMap(({ plan }, i) =>
		plan.startFrame == null || plan.endFrame == null || plan.startFrame < 0 || plan.endFrame <= plan.startFrame ? [i] : []);
	for (let i = 0; i < queue.length; i++) {
		const index = queue[i];
		if (blocked.has(index)) continue;
		blocked.add(index);
		const { element } = mainPlans[index];
		for (const at of [element.startTime, element.startTime + element.duration]) {
			queue.push(...(byBoundary.get(at) ?? []));
			byBoundary.delete(at);
		}
	}
	const mainByElement = new Map<TimelineElement, ReturnType<typeof proposal>>(mainPlans.map(({ element, plan }, i) =>
		[element, blocked.has(i) && plan.startFrame !== undefined ? { ...plan, startFrame: null, endFrame: null } : plan]));
	let reportedRows = 0;
	for (const { element, track } of all) {
		check();
		if (element === narration) continue;
		const { start, end, startAnchor, endAnchor, followStart, caption, sharedStart, sharedEnd, startFrame, endFrame } =
			mainByElement.get(element) ?? proposal(element, false);
		if (startFrame === undefined || endFrame === undefined) { if (inRange({ start, end })) totals.unanchored++; continue; }
		const oldFrames = frame(end) - frame(start);
		const valid = startFrame !== null && endFrame !== null && startFrame >= 0 && endFrame > startFrame;
		const unchanged = valid && startFrame === frame(start) && endFrame === frame(end);
		const proposedDuration = valid ? (endFrame - startFrame) / rate : 0;
		const fields = element.humanFields ?? [];
		const shorter = valid && endFrame - startFrame < oldFrames;
		const protectedTiming = shorter && fields.some((field) =>
			field === "duration" || field === "trimStart" || field === "retime" || field.startsWith("keyframes.") ||
			field === "caption" || field === "params.content");
		const media = element.type === "video" || element.type === "audio" || element.type === "compound";
		const speed = "retime" in element ? element.retime?.rate ?? 1 : 1;
		const kind = unchanged ? "unchanged" : !valid ? "crossesUnresolvedChange" : protectedTiming ? "shorterThanProtectedContent"
			: !followStart && media && proposedDuration * speed + seconds(element.trimStart) > sourceEnd(element) + 1e-9 ? "needsMoreSource"
			: endFrame - startFrame === oldFrames ? "move" : "trim";
		const shown = inRange({ start, end }) || (valid && inRange({ start: startFrame / rate, end: endFrame / rate }));
		const protectedChanges = !valid ? [] : fields.filter((field) =>
			(field === "start" && startFrame !== frame(start)) ||
			(field === "duration" && endFrame - startFrame !== oldFrames));
		offsets.set(element.id, kind === "unchanged" ? 0
			: valid && !protectedChanges.length && (kind === "move" || kind === "trim") ? startFrame - frame(start) : null);
		if (!shown) continue;
		totals[kind]++;
		if (protectedChanges.length) humanTimingConflicts++;
		if (unchanged && !includeUnchanged) continue;
		reportedRows++;
		if (rows.length >= ROW_LIMIT) continue;
		rows.push({ address: { sceneId: root.id, trackId: track.id, id: element.id, agentId: element.agentId ?? null, path: [] },
			track: track.name.slice(0, 120), anchor: { start: startAnchor ? key(startAnchor) : null,
				end: followStart || !endAnchor ? null : key(endAnchor), keepDuration: followStart },
			evidence: !startAnchor || !endAnchor ? "shared main-track cut" : caption ? "caption words and timing"
				: followStart ? "short audio or effect near a word" : "clip edge near a word",
			old: { start, end }, proposed: valid ? { startFrame, endFrame } : null, kind,
			...((sharedStart || sharedEnd) && { sharedCut: {
				start: sharedStart && startAnchor ? pauseAllocation(startAnchor) : null, end: sharedEnd && endAnchor ? pauseAllocation(endAnchor) : null,
				...(!valid && { decision: "Both edges need a decision." }),
			} }),
			protectedChanges,
			humanEdited: { tracked: !!element.agentId, start: fields.includes("start"), duration: fields.includes("duration"), trimStart: fields.includes("trimStart"),
				retime: fields.includes("retime"), caption: fields.includes("caption") || fields.includes("params.content"),
				keyframes: fields.some((field) => field.startsWith("keyframes.")) } });
	}
	const notes = [];
	let unanchoredNotes = 0;
	for (const note of root.bookmarks) {
		check();
		const start = seconds(note.time), end = seconds(note.time + (note.duration ?? 0));
		if (!note.elementIds?.some((id) => offsets.has(id))) { if (inRange({ start, end })) unanchoredNotes++; continue; }
		const shifts = note.elementIds.map((id) => offsets.get(id));
		const shift = shifts[0];
		const from = frame(seconds(note.time)), to = frame(seconds(note.time + (note.duration ?? 0)));
		const resolved = shift != null && shifts.every((value) => value === shift) && from + shift >= 0;
		if (resolved && shift === 0) continue;
		if (!inRange({ start, end }) && !(resolved && inRange({ start: (from + shift) / rate, end: (to + shift) / rate }))) continue;
		notes.push({ id: note.id ?? `legacy-${note.time}`, old: { start, end },
			proposed: resolved ? { startFrame: from + shift, endFrame: to + shift } : null,
			reason: resolved ? "linked elements move together" : "linked elements have different or unresolved moves" });
	}
	const boundedRows = cap(rows, ROW_LIMIT, 1024 * 1024);
	return { sceneId: root.id, clipId, oldMediaId: narration.mediaId, newMediaId: mediaId, fps, limited,
		...(from > 0 || to < Infinity ? { range: { from, to: to < Infinity ? to : null } } : {}),
		narration: { oldStart: origin, oldEnd: origin + seconds(narration.duration), startFrame: frame(origin), endFrame: frame(origin + newDuration) },
		totals: { ...totals, spans: spans.length, unmatched: unmatched.length, inserted: inserted.length, notes: notes.length,
			unanchoredNotes, humanTimingConflicts, frozen: 0 },
		spans: cap(spans, SPAN_LIMIT, 384 * 1024), unmatched: cap(unmatched, SPAN_LIMIT, 64 * 1024),
		inserted: cap(inserted, SPAN_LIMIT, 64 * 1024), notes: cap(notes, SPAN_LIMIT, 64 * 1024), elements: boundedRows.items,
		omittedElements: reportedRows - boundedRows.items.length };
}
