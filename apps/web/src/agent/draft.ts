// Agent draft ops applied to a copy of the project's scenes. Pure: the bridge loads assets first,
// then wraps the resulting scene list in one command, so the whole draft is one Undo step even
// when it touches several scenes (the root timeline and compound clip contents).
import { type ElementRecord, StaleError, assertNoteNotStale, assertNotStale, assertRippleNotStale, fieldsMapOf, touchedFields } from "./stale";
import type { Bookmark, SceneTracks, TScene, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND, roundMediaTime } from "@/wasm";
import { getGraphicDefinition } from "@/graphics";
import { getFrameTime } from "@/timeline/bookmarks";
import { buildCompoundFromElements, isCompoundElement, relocateVisualCompounds, syncCompoundDurations, ungroupCompoundElement } from "@/timeline/compound";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { FrameRate } from "opencut-wasm";
import { generateUUID } from "@/utils/id";
import { validNote } from "./notes";
import { type AgentElement, type AgentKeyframe, type AgentTrackRef, type LoadedMedia, secs } from "./elements";
import { type BuildContext, applyAgentKeyframes, cloneTracks, placeAgentElement, upsertAgentKeyframe } from "./compound-content";
import { type AgentMatch, type ElementHit, addressOf, getScenePaths, orderedTracks, resolveCompoundTarget, resolveMatch } from "./scene-graph";
import { updateAgentCaption, type AgentCaption } from "./captions";
import { reconcileCaptionEdit } from "@/text/caption";
import { parseSourceWords, type SourceWord } from "@/media/words";
import { type WordRef, cutAtWords, cutWarnings, snapCutsToWords, sourceEnd } from "@/timeline/word-cuts";
import { cutRange, cutRangeBookmarks } from "@/timeline/range-cut";

/** `compound` = add into that compound clip's content (times relative to it). */
export type DraftTrackRef = AgentTrackRef & { compound?: AgentMatch };
export type DraftOp =
	| {
		op: "set"; match: AgentMatch; start?: number; duration?: number; trimStart?: number; params?: Record<string, unknown>; caption?: Partial<AgentCaption>;
		/** `"words"`: after the change, a start or end inside a spoken word moves out of it (see word-cuts). */
		cut?: "words";
		/** Starts the clip where this word starts / ends it where this word ends (see word-cuts `cutAtWords`). */
		startAtWord?: WordRef; endAfterWord?: WordRef;
		/** `merge` (default) upserts these keys; `replace` first drops every keyframe of the element. */
		keyframes?: AgentKeyframe[]; keyframesMode?: "merge" | "replace";
	}
	| { op: "delete"; match: AgentMatch }
	/** Deletes the matched element and puts `element` in its place, as one op (all or nothing). */
	| { op: "replace"; match: AgentMatch; element: Partial<AgentElement>; track?: AgentTrackRef }
	| { op: "note"; text: string; start: number; end?: number; match?: AgentMatch[] }
	| { op: "resolve-note"; id: string }
	| { op: "reply-note"; id: string; text: string }
	| { op: "add"; track: DraftTrackRef; element: AgentElement }
	| { op: "group"; agent_id?: string; name?: string; match: AgentMatch[] }
	| { op: "ungroup"; match: AgentMatch }
	/** Spoken words of a project media file (source seconds), kept with it; later ops of the draft use them. */
	| { op: "words"; mediaId: string; words: SourceWord[] }
	/** Cuts [start, end) (root timeline seconds) out of every track; everything after moves up. */
	| { op: "cut"; start: number; end: number }
	| ({ op: "compound"; track?: DraftTrackRef; agent_id?: string; name: string; start: number; duration?: number; trimStart?: number }
		& Pick<AgentElement, "params" | "keyframes" | "group"> & NonNullable<AgentElement["compound"]>);
/** `atomic: true`: if any op fails, the draft changes nothing. */
export type Draft = { schema: string; rev: string; label?: string; projectId?: string; atomic?: boolean; basedOn?: string; ops: DraftOp[] };
export type Touched = { sceneId: string; elementId: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const INTERPOLATIONS: unknown[] = ["linear", "hold", "bezier"];
const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;

/** Property paths (and values) one `set` keyframe writes: `scale` = both axes, relative to the element's own scale. */
function keyframeTargets(el: any, k: AgentKeyframe): { propertyPath: string; value: number | string }[] {
	if (!k || typeof k !== "object" || typeof k.path !== "string" || !k.path || typeof k.time !== "number" || !Number.isFinite(k.time)
		|| !((typeof k.value === "number" && Number.isFinite(k.value)) || typeof k.value === "string")
		|| (k.interpolation !== undefined && !INTERPOLATIONS.includes(k.interpolation))) {
		throw new Error(`invalid keyframe: ${JSON.stringify(k)}`);
	}
	if (k.path === "scale") {
		return ["transform.scaleX", "transform.scaleY"].map((propertyPath) => ({ propertyPath, value: Number(k.value) * (typeof el.params?.[propertyPath] === "number" ? el.params[propertyPath] : 1) }));
	}
	if (el.type === "graphic" && el.definitionId && getGraphicDefinition({ definitionId: el.definitionId }).params.some((p) => p.key === k.path)) {
		return [{ propertyPath: `params.${k.path}`, value: k.value }];
	}
	return [{ propertyPath: k.path, value: k.value }];
}

export function computeAgentDraft({ scenes, rootSceneId, ops, mediaFor, canvas, fps, ripple, atomic = false, results: initial = [], base, wordsOf }: {
	scenes: TScene[]; rootSceneId: string; ops: DraftOp[]; mediaFor: (e: AgentElement) => LoadedMedia | undefined;
	canvas: { width: number; height: number }; fps: FrameRate; ripple: boolean; atomic?: boolean; results?: any[];
	/** Element state at the draft's `basedOn` snapshot: set/replace/delete on fields changed since then are stale. */
	base?: Map<string, ElementRecord>;
	/** Spoken words of a project media file, if known. */
	wordsOf?: (mediaId: string) => SourceWord[] | undefined;
}): { scenes: TScene[]; results: any[]; touched: Touched[]; applied: boolean; words: Map<string, SourceWord[]> } {
	let list = scenes;
	// Words set by `words` ops of this draft (the bridge stores them once it commits).
	const draftWords = new Map<string, SourceWord[]>();
	const wordsFor = (mediaId: unknown) => (typeof mediaId === "string" ? draftWords.get(mediaId) ?? wordsOf?.(mediaId) : undefined);
	const elementIn = (sceneId: string, elementId: string) =>
		orderedTracks(sceneOf(sceneId).tracks).flatMap((track): TimelineElement[] => track.elements).find((e) => e.id === elementId);
	const checkCut = (cut: unknown) => {
		if (cut !== undefined && cut !== "words") throw new Error('cut must be "words"');
		return cut === "words";
	};
	const needWords = (words: SourceWord[] | undefined) => {
		if (!words) throw new Error('cut: "words" needs the media\'s words (asset.words or a words op)');
		return words;
	};
	/**
	 * Moves the cuts of an element just placed out of spoken words; fails if its end would then run into
	 * the next clip on its track. Returns the element as it is now.
	 */
	const snapPlaced = (sceneId: string, elementId: string, words: SourceWord[], at?: { startWord?: WordRef; endWord?: WordRef; result: any }) =>
		editTracks(sceneId, (tracks) => {
			for (const track of orderedTracks(tracks) as any[]) {
				const index = track.elements.findIndex((e: TimelineElement) => e.id === elementId);
				if (index < 0) continue;
				const el = track.elements[index];
				// What was built (a text or compound with a mediaId has no cuts to snap).
				if (el.type !== "video" && el.type !== "audio") throw new Error('cut: "words" is for video and audio clips');
				let snapped = null;
				if (at) {
					const cut = cutAtWords(el, words, fps, { startWord: at.startWord, endWord: at.endWord });
					if (typeof cut === "string") throw new Error(cut);
					snapped = cut.patch;
					if (cut.start) at.result.startWord = cut.start;
					if (cut.end) at.result.endWord = cut.end;
				} else snapped = snapCutsToWords(el, words, fps);
				if (!snapped) return el;
				const next = { ...el, ...snapped };
				// The clip was just placed in a free spot: its new span must not reach any other clip.
				const end = next.startTime + next.duration;
				const clash = track.elements.find((other: TimelineElement, j: number) => j !== index && other.startTime < end && other.startTime + other.duration > next.startTime);
				if (clash) throw new Error(`the clip cut at its words would overlap ${clash.name || clash.id}; make room first`);
				track.elements[index] = next;
				return next;
			}
			throw new Error(`element not found: ${elementId}`);
			// The clip was just added: rounding it a hair shorter must not pull the clips after it.
		}, { noRipple: true });
	/** A clip snapped longer must not run into the next clip on its track (ripple only closes gaps). */
	const assertRoomForEnd = (elements: TimelineElement[], index: number, requestedEnd: number, end: number) => {
		const blocked = elements.find((other, j) => j !== index && other.startTime >= requestedEnd && other.startTime < end);
		if (blocked) throw new Error(`snapping to the word's end would overlap ${blocked.name || blocked.id}; make room for the whole word first`);
	};
	/** `cut` only on a top-level add or set (inside a compound it would not be applied). */
	const refuseNestedCut = (elements: unknown[]) => {
		for (const e of elements as AgentElement[]) {
			if (!e || typeof e !== "object") continue;
			if (e.cut !== undefined || e.startAtWord !== undefined || e.endAfterWord !== undefined) throw new Error("cut, startAtWord and endAfterWord work on a top-level add or set, not inside a compound or a replace");
			const content = e.compound;
			if (content) refuseNestedCut([...(content.main ?? []), ...(content.overlay ?? []).flatMap((t) => t.elements ?? []), ...(content.audio ?? []), ...(content.elements ?? [])]);
		}
	};
	// The timeline before this draft: stale checks compare the snapshot with it, never with the draft's own edits.
	const now = base ? fieldsMapOf(scenes) : undefined;
	const results: any[] = [...initial];
	const touched: Touched[] = [];
	const finish: (() => void)[] = [];
	const sceneOf = (sceneId: string) => {
		const scene = list.find((s) => s.id === sceneId);
		if (!scene) throw new Error(`scene not found: ${sceneId}`);
		return scene;
	};
	const replace = (scene: TScene) => { list = list.map((s) => (s.id === scene.id ? scene : s)); };
	/** Edits one scene's tracks; plain edits ripple like a timeline edit when ripple editing is on. */
	const editTracks = <T>(sceneId: string, edit: (tracks: SceneTracks) => T, { noRipple = false }: { noRipple?: boolean } = {}): T => {
		const scene = sceneOf(sceneId);
		const tracks = cloneTracks(scene.tracks);
		const out = edit(tracks);
		const next = ripple && !noRipple ? applyRippleAdjustments({ tracks, adjustments: computeRippleAdjustments({ beforeTracks: scene.tracks, afterTracks: tracks }) }) : tracks;
		// A clip this edit moves (explicitly or by ripple) must not be one the user moved after basedOn.
		assertRippleNotStale({ base, now, sceneId, before: scene.tracks, after: next });
		replace({ ...scene, tracks: next, updatedAt: new Date() });
		return out;
	};
	const find = (match: unknown): ElementHit => {
		const resolved = resolveMatch(list, rootSceneId, match);
		if ("error" in resolved) throw new Error(resolved.error);
		return resolved.hit;
	};
	// Addresses are resolved once the draft is complete, against the final scenes (paths computed once).
	let paths: Map<string, string[]> | undefined;
	const at = (sceneId: string, elementId: string) => addressOf(list, rootSceneId, sceneId, elementId, (paths ??= getScenePaths(list, rootSceneId)));
	const address = (result: any, key: string, sceneId: string, elementId: string) => {
		finish.push(() => { result[key] = at(sceneId, elementId); });
	};
	const addresses = (result: any, key: string, refs: Touched[]) => {
		finish.push(() => { result[key] = refs.map((ref) => at(ref.sceneId, ref.elementId)); });
	};
	const bookmarksOfRoot = () => [...sceneOf(rootSceneId).bookmarks];
	const setRootBookmarks = (bookmarks: Bookmark[]) => replace({ ...sceneOf(rootSceneId), bookmarks });

	const add = (track: DraftTrackRef | undefined, element: AgentElement, result: any) => {
		if (!track || typeof track.name !== "string") throw new Error("add needs track:{name}");
		if (!element || typeof element !== "object") throw new Error("add needs an element");
		let sceneId = rootSceneId;
		if (track.compound !== undefined) {
			const target = resolveCompoundTarget(list, rootSceneId, track.compound);
			if ("error" in target) throw new Error(target.error);
			sceneId = target.sceneId;
		}
		const cutWords = checkCut(element.cut);
		const content = element.compound;
		if (content) refuseNestedCut([...(content.main ?? []), ...(content.overlay ?? []).flatMap((t) => t.elements ?? []), ...(content.audio ?? []), ...(content.elements ?? [])]);
		let words: SourceWord[] | undefined;
		const atWords = element.startAtWord !== undefined || element.endAfterWord !== undefined;
		if (atWords && cutWords) throw new Error("startAtWord/endAfterWord already cut at words (no cut needed)");
		if (element.startAtWord !== undefined && element.trimStart !== undefined) throw new Error("startAtWord replaces trimStart");
		if (element.endAfterWord !== undefined && element.duration !== undefined) throw new Error("endAfterWord replaces duration");
		if (cutWords || atWords) {
			const loaded = mediaFor(element);
			if (!loaded || (loaded.type !== "video" && loaded.type !== "audio")) throw new Error('cut: "words" is for video and audio clips');
			words = needWords(draftWords.get(loaded.id) ?? loaded.words ?? wordsOf?.(loaded.id));
		}
		const ctx: BuildContext = { canvas, keyframes: [], mediaFor, existing: list, created: [] };
		// Placed as usual first (defaults, track, place), then its cuts move out of words.
		const placed = editTracks(sceneId, (tracks) => placeAgentElement({ tracks, sceneId, e: element, ref: track, ctx }));
		if (words) placed.element = snapPlaced(sceneId, placed.element.id, words, atWords ? { startWord: element.startAtWord, endWord: element.endAfterWord, result } : undefined);
		placedElement(sceneId, track.name, placed, ctx, result);
	};
	/** Keyframes, nested scenes, selection, and result addresses of an element just placed. */
	const placedElement = (sceneId: string, trackName: string, placed: { element: any }, ctx: BuildContext, result: any) => {
		list = applyAgentKeyframes({ scenes: [...list, ...ctx.created], keyframes: ctx.keyframes, defaultSceneId: sceneId });
		touched.push({ sceneId, elementId: placed.element.id });
		result.track = trackName;
		address(result, "element", sceneId, placed.element.id);
		if (isCompoundElement(placed.element)) {
			result.sceneId = placed.element.sceneId;
			const nested = ctx.created.flatMap((scene) => orderedTracks(scene.tracks).flatMap((t) => t.elements.map((e) => ({ sceneId: scene.id, elementId: e.id }))));
			addresses(result, "elements", nested);
		}
	};

	const run = (op: DraftOp, result: any) => {
		switch (op.op) {
			case "add":
				result.agentId = op.element?.agent_id;
				add(op.track, op.element, result);
				return;
			case "compound": {
				const { op: _op, track, agent_id, name, start, duration, trimStart, params, keyframes, group, main, overlay, audio, elements } = op;
				result.agentId = agent_id;
				add(track ?? { name: "Compound clips" }, { agent_id, name, start, duration: duration as number, trimStart, params, keyframes, group, compound: { main, overlay, audio, elements } }, result);
				finish.push(() => { result.compound = result.element; });
				return;
			}
			case "set": {
				const cutWords = checkCut(op.cut);
				const hit = find(op.match);
				let setWords: SourceWord[] | undefined;
				const atWords = op.startAtWord !== undefined || op.endAfterWord !== undefined;
				if (atWords && (op.trimStart !== undefined || op.duration !== undefined || cutWords)) throw new Error("startAtWord/endAfterWord replace trimStart, duration and cut");
				if (cutWords || atWords) {
					if (hit.element.type !== "video" && hit.element.type !== "audio") throw new Error('cut: "words" is for video and audio clips');
					setWords = needWords(wordsFor((hit.element as { mediaId?: unknown }).mediaId));
				}
				assertNotStale({ base, now, sceneId: hit.sceneId, element: hit.element, fields: touchedFields(op), scenes: list });
				editTracks(hit.sceneId, (tracks) => {
					const track = orderedTracks(tracks).find((t) => t.id === hit.track.id) as any;
					const el = track.elements[hit.index];
					const patch: any = {};
					if (op.start !== undefined) patch.startTime = secs(op.start);
					if (op.duration !== undefined) patch.duration = secs(op.duration);
					if (op.trimStart !== undefined) patch.trimStart = secs(op.trimStart);
					if (el.sourceDuration !== undefined && (patch.duration !== undefined || patch.trimStart !== undefined)) {
						patch.trimEnd = Math.max(0, el.sourceDuration - (patch.trimStart ?? el.trimStart) - (patch.duration ?? el.duration));
					}
					if (op.params) patch.params = { ...el.params, ...op.params };
					if (op.caption && el.type !== "text") throw new Error("caption can only update a text element");
					let next = { ...el, ...patch };
					if (op.keyframes !== undefined || op.keyframesMode !== undefined) {
						if (!Array.isArray(op.keyframes)) throw new Error("set: keyframes must be a list");
						const mode = op.keyframesMode ?? "merge";
						if (mode !== "merge" && mode !== "replace") throw new Error(`set: unknown keyframesMode ${mode}`);
						if (mode === "replace") {
							const { animations: _dropped, ...rest } = next;
							next = rest;
						}
						// Every key is checked against its animation target (strict) before the op counts:
						// one invalid key fails the op, so a `replace` never ends with keys dropped.
						for (const k of op.keyframes) {
							for (const target of keyframeTargets(next, k)) next = upsertAgentKeyframe(next, { ...target, time: k.time, interpolation: k.interpolation }, { strict: true });
						}
					}
					if (setWords && atWords) {
						const cut = cutAtWords(next, setWords, fps, { startWord: op.startAtWord, endWord: op.endAfterWord, limit: sourceEnd(el) });
						if (typeof cut === "string") throw new Error(cut);
						const requestedEnd = next.startTime + next.duration;
						next = { ...next, ...cut.patch };
						assertRoomForEnd(track.elements, hit.index, requestedEnd, next.startTime + next.duration);
						if (cut.start) result.startWord = cut.start;
						if (cut.end) result.endWord = cut.end;
					} else if (setWords) {
						// The source ends where it did before this op (a shorter clip does not shorten its file).
						const snapped = snapCutsToWords(next, setWords, fps, { limit: sourceEnd(el) });
						if (snapped) {
							const requestedEnd = next.startTime + next.duration;
							next = { ...next, ...snapped };
							assertRoomForEnd(track.elements, hit.index, requestedEnd, next.startTime + next.duration);
						}
					}
					track.elements[hit.index] = el.type === "text" && next.type === "text"
						? op.caption ? updateAgentCaption(reconcileCaptionEdit(el, next), op.caption) : reconcileCaptionEdit(el, next)
						: next;
				});
				touched.push({ sceneId: hit.sceneId, elementId: hit.element.id });
				address(result, "element", hit.sceneId, hit.element.id);
				return;
			}
			case "cut": {
				if (typeof op.start !== "number" || typeof op.end !== "number" || !Number.isFinite(op.start) || !Number.isFinite(op.end) || op.start < 0 || op.end <= op.start) {
					throw new Error("cut needs start and end in seconds, start < end");
				}
				// On whole frames: the start rounds up and the end down, so what stays on either side is never cut
				// into (and notes and clips after the cut stay on frames).
				const frameTicks = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
				const start = Math.round(Math.ceil(secs(op.start) / frameTicks - 1e-9) * frameTicks) as MediaTime;
				const end = Math.round(Math.floor(secs(op.end) / frameTicks + 1e-9) * frameTicks) as MediaTime;
				if (end <= start) throw new Error("cut: the range is shorter than a frame");
				const cut = editTracks(rootSceneId, (tracks) => {
					const out = cutRange({ tracks, start, end, newId: generateUUID });
					// What the user changed since basedOn is never cut away or trimmed by an older draft.
					for (const element of out.removed) assertNotStale({ base, now, sceneId: rootSceneId, element, fields: "all", scenes: list });
					// Trimming rewrites fades, keyframes and timing: a clip the user changed in any way is left alone.
					for (const element of out.trimmed) assertNotStale({ base, now, sceneId: rootSceneId, element, fields: "all", scenes: list });
					tracks.overlay = out.tracks.overlay;
					tracks.main = out.tracks.main;
					tracks.audio = out.tracks.audio;
					return out;
				}, { noRipple: true });
				setRootBookmarks(cutRangeBookmarks(bookmarksOfRoot(), start, end, Math.round(frameTicks) as MediaTime));
				result.start = start / TICKS_PER_SECOND;
				result.end = end / TICKS_PER_SECOND;
				for (const element of cut.kept) touched.push({ sceneId: rootSceneId, elementId: element.id });
				result.removed = cut.removed.length;
				result.trimmed = cut.trimmed.length;
				result.shifted = cut.shifted.length;
				addresses(result, "kept", cut.kept.map((element) => ({ sceneId: rootSceneId, elementId: element.id })));
				return;
			}
			case "words": {
				if (typeof op.mediaId !== "string") throw new Error("words needs mediaId");
				const words = parseSourceWords(op.words);
				if (!words) throw new Error("words must be a list of {text, start, end} in seconds");
				draftWords.set(op.mediaId, words);
				result.mediaId = op.mediaId;
				result.words = words.length;
				return;
			}
			case "replace": {
				const hit = find(op.match);
				assertNotStale({ base, now, sceneId: hit.sceneId, element: hit.element, fields: "all", scenes: list });
				const given = op.element;
				if (!given || typeof given !== "object") throw new Error("replace needs an element");
				refuseNestedCut([given]);
				if (op.track !== undefined && (typeof op.track?.name !== "string" || "compound" in op.track)) throw new Error("replace: track needs {name} and stays in the element's scene");
				const old = hit.element;
				// Unset fields keep the replaced element's agentId, name, and span.
				const element = {
					...given, agent_id: given.agent_id ?? old.agentId, name: given.name ?? old.name,
					start: given.start ?? seconds(old.startTime), duration: given.duration ?? seconds(old.duration),
				} as AgentElement;
				result.agentId = element.agent_id;
				const ref = op.track ?? { name: hit.track.name, id: hit.track.id };
				// Media were loaded for the element as given; `element` is a new object built from it.
				const ctx: BuildContext = { canvas, keyframes: [], mediaFor: (e) => mediaFor(e === element ? given as AgentElement : e), existing: list, created: [] };
				// One edit: ripple editing sees a replacement, not a removal followed by an insertion.
				const placed = editTracks(hit.sceneId, (tracks) => {
					(orderedTracks(tracks).find((t) => t.id === hit.track.id) as any).elements.splice(hit.index, 1);
					return placeAgentElement({ tracks, sceneId: hit.sceneId, e: element, ref, ctx });
				});
				result.replaced = { sceneId: hit.sceneId, id: old.id };
				placedElement(hit.sceneId, ref.name, placed, ctx, result);
				return;
			}
			case "delete": {
				const hit = find(op.match);
				assertNotStale({ base, now, sceneId: hit.sceneId, element: hit.element, fields: "all", scenes: list });
				editTracks(hit.sceneId, (tracks) => {
					(orderedTracks(tracks).find((t) => t.id === hit.track.id) as any).elements.splice(hit.index, 1);
				});
				result.element = { sceneId: hit.sceneId, id: hit.element.id };
				return;
			}
			case "group": {
				if (!Array.isArray(op.match) || op.match.length === 0) throw new Error("group needs match:[...]");
				const hits = op.match.map(find);
				const hostSceneId = hits[0].sceneId;
				if (hits.some((hit) => hit.sceneId !== hostSceneId)) throw new Error("group: all elements must be in the same scene");
				// Grouping moves clips off their tracks: not ones the user moved to another track (or whose track
				// they changed) since basedOn.
				for (const hit of hits) assertNotStale({ base, now, sceneId: hit.sceneId, element: hit.element, fields: ["track"], scenes: list });
				const built = buildCompoundFromElements({
					scenes: list, hostSceneId, name: op.name,
					elements: hits.map((hit) => ({ trackId: hit.track.id, elementId: hit.element.id })),
				});
				list = built.scenes;
				if (op.agent_id) {
					const host = sceneOf(hostSceneId);
					const tracks = cloneTracks(host.tracks);
					const track = orderedTracks(tracks).find((t) => t.id === built.compound.trackId) as any;
					track.elements = track.elements.map((e: any) => (e.id === built.compound.elementId ? { ...e, agentId: op.agent_id } : e));
					replace({ ...host, tracks });
				}
				result.agentId = op.agent_id;
				result.sceneId = built.sceneId;
				touched.push({ sceneId: hostSceneId, elementId: built.compound.elementId });
				address(result, "compound", hostSceneId, built.compound.elementId);
				addresses(result, "elements", hits.map((hit) => ({ sceneId: built.sceneId, elementId: hit.element.id })));
				return;
			}
			case "ungroup": {
				const hit = find(op.match);
				if (!isCompoundElement(hit.element)) throw new Error("ungroup: not a compound clip");
				// Ungrouping can give the content new ids (later ops would see it as new) and drops the content
				// scene with its notes: refused if the user changed the compound or anything in it since basedOn.
				assertNotStale({ base, now, sceneId: hit.sceneId, element: hit.element, fields: "all", scenes: list });
				const restored = ungroupCompoundElement({ scenes: list, hostSceneId: hit.sceneId, ref: { trackId: hit.track.id, elementId: hit.element.id } });
				list = restored.scenes;
				const refs = restored.elements.map((ref) => ({ sceneId: hit.sceneId, elementId: ref.elementId }));
				touched.push(...refs);
				addresses(result, "elements", refs);
				return;
			}
			case "note": {
				if (!validNote(op.text, op.start, op.end) || (op.match !== undefined && !Array.isArray(op.match))) throw new Error("invalid note");
				const bookmarks = bookmarksOfRoot();
				const time = getFrameTime({ time: secs(op.start), fps });
				if (bookmarks.some((b) => b.time === time)) throw new Error("bookmark already exists at this time");
				const hits = (op.match ?? []).map(find);
				const id = generateUUID();
				bookmarks.push({ id, time, note: op.text, duration: op.end === undefined ? undefined : roundMediaTime({ time: Math.max(0, secs(op.end) - time) }), elementIds: hits.map((hit) => hit.element.id), author: "agent", resolved: false, createdAt: new Date().toISOString() });
				setRootBookmarks(bookmarks);
				result.id = id;
				return;
			}
			case "reply-note": {
				const bookmarks = bookmarksOfRoot();
				const index = bookmarks.findIndex((b) => (b.id ?? `legacy-${b.time}`) === op.id && b.note?.trim());
				result.id = op.id;
				if (index < 0 || typeof op.text !== "string" || !op.text.trim()) throw new Error("invalid note or reply");
				const reply = { id: generateUUID(), text: op.text, author: "agent" as const, createdAt: new Date().toISOString() };
				bookmarks[index] = { ...bookmarks[index], replies: [...(bookmarks[index].replies ?? []), reply] };
				setRootBookmarks(bookmarks);
				result.replyId = reply.id;
				return;
			}
			case "resolve-note": {
				const bookmarks = bookmarksOfRoot();
				const index = bookmarks.findIndex((b) => (b.id ?? `legacy-${b.time}`) === op.id && b.note?.trim());
				result.id = op.id;
				if (index < 0) throw new Error("note not found");
				// Not a note the user reopened (or changed) since basedOn.
				assertNoteNotStale({ base, now, sceneId: rootSceneId, noteId: op.id });
				bookmarks[index] = { ...bookmarks[index], resolved: true };
				setRootBookmarks(bookmarks);
				return;
			}
			default:
				throw new Error(`unknown op: ${(op as { op?: unknown })?.op}`);
		}
	};

	for (const [i, op] of ops.entries()) {
		if (results[i]) continue;
		const result: any = { op: op?.op };
		if (op && "match" in op && op.match !== undefined) result.match = op.match;
		const saved = { list, touched: touched.length, finish: finish.length };
		try {
			run(op, result);
			result.ok = true;
			// Cuts this op left inside a spoken word (video and audio clips whose media has words).
			const warnings = touched.slice(saved.touched).flatMap(({ sceneId, elementId }) => {
				const element = elementIn(sceneId, elementId) as (TimelineElement & { mediaId?: unknown }) | undefined;
				if (!element || (element.type !== "video" && element.type !== "audio")) return [];
				const fromAsset = op?.op === "add" || op?.op === "replace" ? mediaFor(op.element as AgentElement)?.words : undefined;
				const words = (typeof element.mediaId === "string" ? draftWords.get(element.mediaId) : undefined) ?? fromAsset ?? wordsFor(element.mediaId);
				return words ? cutWarnings(element, words).map((warning) => ({ elementId, ...warning })) : [];
			});
			if (warnings.length) result.cutWarnings = warnings;
		} catch (error) {
			// An op that fails changes nothing; the rest of the draft still applies.
			list = saved.list;
			touched.length = saved.touched;
			finish.length = saved.finish;
			for (const key of Object.keys(result)) if (key !== "op" && key !== "match" && key !== "id" && key !== "agentId") delete result[key];
			if (op?.op === "add") result.name = op.element?.name;
			result.ok = false;
			result.error = message(error);
			if (error instanceof StaleError) {
				result.stale = true;
				result.fields = error.fields;
				result.current = error.current;
			}
		}
		results[i] = result;
	}
	if (atomic && results.some((r) => !r?.ok)) {
		// All or nothing: the ops that would have applied are reported as skipped; nothing changes.
		const skipped = (r: any) => ({ op: r.op, ...(r.match !== undefined ? { match: r.match } : {}), ...(r.agentId !== undefined ? { agentId: r.agentId } : {}), ok: false, skipped: true, error: "not applied: another op of this atomic draft failed" });
		return { scenes, touched: [], applied: false, results: results.map((r) => (r?.ok ? skipped(r) : r)), words: new Map() };
	}
	// Derived compound state up front (track relocation, durations), so applying the draft adds no
	// side effects to other scenes and one undo restores exactly what it changed.
	list = syncCompoundDurations(relocateVisualCompounds(list));
	for (const fill of finish) fill();
	return { scenes: list, results, touched, applied: true, words: draftWords };
}
