// In and out animation presets, written as ordinary keyframes (and, for blur, a blur effect) that stay
// editable. Their keyframe ids start with `anim-in-` / `anim-out-`, so applying a preset again replaces
// the earlier preset's keyframes and never the user's own. Out presets stay at the clip's end when its
// length changes (see reanchorOutPreset).
import type { ElementAnimations, NormalizedCubicBezier, ScalarAnimationKey } from "@/animation/types";
import { getCurveHandlesForNormalizedCubicBezier } from "@/animation/curve-bridge";
import { getChannelsFromData, isLeafChannelData } from "@/animation/channel-data";
import { removeElementKeyframe, updateScalarKeyframeCurve, upsertPathKeyframe } from "@/animation/keyframes";
import { resolveAnimationPathValueAtTime } from "@/animation/resolve";
import { buildEffectParamPath } from "@/animation/effect-param-channel";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { isVisualElement } from "@/timeline/element-utils";
import type { TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND, roundMediaTime } from "@/wasm";

export const ANIMATION_IN_TYPES = ["fade", "pop", "impact", "blur", "typewriter"] as const;
export const ANIMATION_OUT_TYPES = ["fade", "fall", "dissolve"] as const;
export type AnimationInType = (typeof ANIMATION_IN_TYPES)[number];
export type AnimationOutType = (typeof ANIMATION_OUT_TYPES)[number];

/** Seconds each preset takes when no duration is given. */
export const DEFAULT_IN_SECONDS: Record<AnimationInType, number> = { fade: 0.3, pop: 0.35, impact: 0.25, blur: 0.4, typewriter: 1 };
export const DEFAULT_OUT_SECONDS: Record<AnimationOutType, number> = { fade: 0.3, fall: 0.5, dissolve: 0.5 };

/** `none` removes that side's preset. */
export type AnimationPresetRequest = {
	in?: { type: AnimationInType | "none"; duration?: number };
	out?: { type: AnimationOutType | "none"; duration?: number };
};

/** The blur effect the blur presets animate (added when needed, removed with them). */
export const PRESET_BLUR_EFFECT_ID = "anim-blur";
const BLUR_PATH = buildEffectParamPath({ effectId: PRESET_BLUR_EFFECT_ID, paramKey: "intensity" });
const BLUR_AMOUNT = 30;

const EASE_OUT: NormalizedCubicBezier = [0.33, 1, 0.68, 1];
const EASE_IN: NormalizedCubicBezier = [0.32, 0, 0.67, 0];
const EASE_IN_OUT: NormalizedCubicBezier = [0.65, 0, 0.35, 1];

type Side = "in" | "out";
/**
 * One animated property of a preset: points of its window (0 = window start, 1 = end). The `join` point is
 * where it meets the rest of the clip: it takes the property's own value there (`edge`), which the other
 * points scale from.
 */
type Point = { at: number; value?: (edge: number) => number; join?: true; ease?: NormalizedCubicBezier };
type Track = { path: string; points: Point[] };

export const presetPrefix = (side: Side) => `anim-${side}-`;
/** Which side's preset a keyframe id belongs to, if any. */
export function presetSideOf(id: string): Side | null {
	return id.startsWith("anim-in-") ? "in" : id.startsWith("anim-out-") ? "out" : null;
}

/** The tracks of a preset. */
function presetTracks(side: Side, type: string, canvasHeight: number): Track[] {
	const to = (value: number) => () => value;
	const times = (factor: number) => (edge: number) => edge * factor;
	const opacityIn = (end: number): Track => ({ path: "opacity", points: [{ at: 0, value: to(0), ease: EASE_OUT }, { at: end, join: true }] });
	const opacityOut = (start: number): Track => ({ path: "opacity", points: [{ at: start, join: true, ease: EASE_IN }, { at: 1, value: to(0) }] });
	const scale = (points: Point[]): Track[] => ["transform.scaleX", "transform.scaleY"].map((path) => ({ path, points }));
	if (side === "in") {
		switch (type) {
			case "fade":
				return [opacityIn(1)];
			case "pop":
				// Grows past its size, then settles.
				return [opacityIn(0.4), ...scale([{ at: 0, value: times(0.5), ease: EASE_OUT }, { at: 0.65, value: times(1.1), ease: EASE_IN_OUT }, { at: 1, join: true }])];
			case "impact":
				// Comes down from large and lands hard.
				return [opacityIn(0.3), ...scale([{ at: 0, value: times(1.6), ease: EASE_IN }, { at: 1, join: true }])];
			case "blur":
				return [opacityIn(0.5), { path: BLUR_PATH, points: [{ at: 0, value: to(BLUR_AMOUNT), ease: EASE_OUT }, { at: 1, join: true }] }];
			case "typewriter":
				return [{ path: "typewriter", points: [{ at: 0, value: to(0) }, { at: 1, join: true }] }];
		}
	} else {
		switch (type) {
			case "fade":
				return [opacityOut(0)];
			case "fall":
				// Drops and tips over while it fades.
				return [
					opacityOut(0.3),
					{ path: "transform.positionY", points: [{ at: 0, join: true, ease: EASE_IN }, { at: 1, value: (edge) => edge + canvasHeight * 0.25 }] },
					{ path: "transform.rotate", points: [{ at: 0, join: true, ease: EASE_IN }, { at: 1, value: (edge) => edge + 8 }] },
				];
			case "dissolve":
				return [
					opacityOut(0),
					{ path: BLUR_PATH, points: [{ at: 0, join: true, ease: EASE_IN }, { at: 1, value: to(BLUR_AMOUNT) }] },
					...scale([{ at: 0, join: true, ease: EASE_OUT }, { at: 1, value: times(1.05) }]),
				];
		}
	}
	throw new Error(`unknown ${side} animation: ${type}`);
}

const usesBlur = (side: Side, type: string | undefined) => (side === "in" ? type === "blur" : type === "dissolve");

/** Every keyframe of the element whose id marks it as one side's preset, with its path and time. */
function presetKeys(animations: ElementAnimations | undefined, side: Side): { path: string; id: string; time: number }[] {
	const found: { path: string; id: string; time: number }[] = [];
	for (const [path, data] of Object.entries(animations ?? {})) {
		if (!data) continue;
		for (const channel of getChannelsFromData({ data })) {
			for (const key of channel?.keys ?? []) if (presetSideOf(key.id) === side && !found.some((f) => f.path === path && f.id === key.id)) found.push({ path, id: key.id, time: key.time });
		}
	}
	return found;
}

function withoutPreset<T extends TimelineElement>(element: T, side: Side): T {
	let animations = element.animations;
	for (const { path, id } of presetKeys(animations, side)) animations = removeElementKeyframe({ animations, propertyPath: path, keyframeId: id });
	return { ...element, animations };
}

/** The element's blur effect for presets, added if missing (intensity 0, so it changes nothing by itself). */
function withPresetBlur<T extends TimelineElement>(element: T): T {
	const effects = (element as { effects?: { id: string }[] }).effects ?? [];
	if (effects.some((effect) => effect.id === PRESET_BLUR_EFFECT_ID)) return element;
	return { ...element, effects: [...effects, { id: PRESET_BLUR_EFFECT_ID, type: "blur", params: { intensity: 0 }, enabled: true }] };
}

/** The preset blur effect goes when no keyframe animates it any more and it blurs nothing. */
function dropUnusedBlur<T extends TimelineElement>(element: T): T {
	const effects = (element as { effects?: { id: string; params: Record<string, unknown> }[] }).effects;
	const blur = effects?.find((effect) => effect.id === PRESET_BLUR_EFFECT_ID);
	if (!effects || !blur || element.animations?.[BLUR_PATH] || (blur.params.intensity !== 0 && blur.params.intensity !== undefined)) return element;
	return { ...element, effects: effects.filter((effect) => effect !== blur) };
}

function valueAt(element: TimelineElement, path: string, time: number): number {
	const target = resolveAnimationTarget({ element, path });
	const base = target?.getBaseValue();
	const fallback = typeof base === "number" ? base : 0;
	const value = resolveAnimationPathValueAtTime({ animations: element.animations, propertyPath: path, localTime: time, fallbackValue: fallback });
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const scalarKeys = (element: TimelineElement, path: string): ScalarAnimationKey[] => {
	const data = element.animations?.[path];
	return isLeafChannelData(data) ? ((data.keys ?? []) as ScalarAnimationKey[]) : [];
};

const seconds = (ticks: number) => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;

function writeTracks<T extends TimelineElement>(element: T, side: Side, type: string, tracks: Track[], window: { start: number; end: number }): T {
	let next = element;
	const span = window.end - window.start;
	const timeOf = (point: Point) => roundMediaTime({ time: window.start + span * point.at }) as MediaTime;
	let n = 0;
	for (const track of tracks) {
		const target = resolveAnimationTarget({ element: next, path: track.path });
		if (!target) throw new Error(`${side} ${type}: this clip has no ${track.path} to animate`);
		const join = track.points.find((point) => point.join)!;
		// The preset's window holds only its own keys: a keyframe of the clip's own there would be written over
		// or cut into, so the request fails and names it.
		const mine = scalarKeys(next, track.path).find((key) => !presetSideOf(key.id) && key.time >= window.start - 1 && key.time <= window.end + 1);
		if (mine) {
			throw new Error(`${side} ${type}: ${track.path} has its own keyframe at ${seconds(mine.time)} s, inside the preset (${seconds(window.start)} to ${seconds(window.end)} s); move or delete it first`);
		}
		// The property's own value where the preset meets the rest of the clip (before anything is written).
		const edge = valueAt(next, track.path, timeOf(join));
		const ids: string[] = [];
		for (const point of track.points) {
			const time = timeOf(point);
			const id = `${presetPrefix(side)}${track.path}-${n++}`;
			ids.push(id);
			const animations = upsertPathKeyframe({
				animations: next.animations, propertyPath: track.path, time,
				value: point.join ? edge : point.value!(edge), interpolation: point.ease ? "bezier" : "linear", keyframeId: id,
				channelLayout: target.channelLayout, coerceValue: target.coerceValue,
			});
			next = { ...next, animations };
		}
		const keyOf = (id: string | undefined) => scalarKeys(next, track.path).find((key) => key.id === id);
		track.points.forEach((point, index) => {
			const left = keyOf(ids[index]);
			const right = keyOf(ids[index + 1]);
			// Easing; a segment between equal values stays flat (no overshoot).
			if (!left || !right || !point.ease || left.value === right.value) return;
			const handles = getCurveHandlesForNormalizedCubicBezier({ leftKey: left, rightKey: right, cubicBezier: point.ease });
			if (!handles) return;
			let animations = updateScalarKeyframeCurve({ animations: next.animations, propertyPath: track.path, componentKey: "value", keyframeId: left.id, patch: { rightHandle: handles.rightHandle, segmentToNext: "bezier", tangentMode: "broken" } });
			animations = updateScalarKeyframeCurve({ animations, propertyPath: track.path, componentKey: "value", keyframeId: right.id, patch: { leftHandle: handles.leftHandle, tangentMode: "broken" } });
			next = { ...next, animations };
		});
	}
	return next;
}

/** How long a side's preset is now, in ticks (0 without one). */
function presetLength(element: TimelineElement, side: Side): number {
	const keys = presetKeys(element.animations, side);
	if (!keys.length) return 0;
	return side === "in" ? Math.max(...keys.map((key) => key.time)) : element.duration - Math.min(...keys.map((key) => key.time));
}

/**
 * Applies in and out presets to an element (pure). Each side asked for replaces that side's earlier preset;
 * keyframes of the clip's own are kept, and the preset starts and ends at the values they give. Both sides
 * asked for together are shortened to fit the clip; one side gets the room the other leaves.
 */
export function applyAnimationPresets<T extends TimelineElement>(element: T, request: AnimationPresetRequest, { canvasHeight }: { canvasHeight: number }): T {
	const duration = element.duration;
	for (const side of ["in", "out"] as const) {
		const spec = request[side];
		if (!spec) continue;
		const types: readonly string[] = side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES;
		if (spec.type !== "none" && !types.includes(spec.type)) throw new Error(`${side} animation must be one of ${types.join(", ")} or none`);
		if (spec.type === "typewriter" && element.type !== "text") throw new Error("typewriter is for text");
		if (usesBlur(side, spec.type) && !isVisualElement(element)) throw new Error(`${spec.type} needs a clip that takes effects (not a ${element.type} clip)`);
	}
	const wanted = (side: Side) => {
		const spec = request[side];
		if (!spec || spec.type === "none") return 0;
		const fallback = side === "in" ? DEFAULT_IN_SECONDS[spec.type as AnimationInType] : DEFAULT_OUT_SECONDS[spec.type as AnimationOutType];
		const value = spec.duration ?? fallback;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10) throw new Error(`${side} animation duration must be 0 to 10 seconds`);
		return value * TICKS_PER_SECOND;
	};
	const asked = (side: Side) => !!request[side] && request[side]!.type !== "none";
	let ticks = { in: wanted("in"), out: wanted("out") };
	// The two sides never meet at one time (a channel has one keyframe per time): a tick stays between them.
	const room = duration - 2;
	if (asked("in") && asked("out")) {
		if (room < 2) throw new Error("the clip is too short for an in and an out animation");
		if (ticks.in + ticks.out > room) {
			const scale = room / (ticks.in + ticks.out);
			ticks = { in: ticks.in * scale, out: ticks.out * scale };
		}
	} else {
		for (const side of ["in", "out"] as const) {
			if (!asked(side)) continue;
			const other = side === "in" ? "out" : "in";
			const free = room - (request[other] ? 0 : presetLength(element, other));
			if (free < 1) throw new Error(`no room for the ${side} animation: the ${other} animation takes the whole clip (shorten it first)`);
			ticks[side] = Math.min(ticks[side], free);
		}
	}
	// Every side asked for is cleared first, so nothing new is measured from or lands on an old preset.
	let next = element;
	for (const side of ["in", "out"] as const) if (request[side]) next = withoutPreset(next, side);
	for (const side of ["in", "out"] as const) {
		const spec = request[side];
		if (!spec || spec.type === "none") continue;
		const tracks = presetTracks(side, spec.type, canvasHeight);
		if (tracks.some((track) => track.path === BLUR_PATH)) next = withPresetBlur(next);
		next = writeTracks(next, side, spec.type, tracks, side === "in" ? { start: 0, end: ticks.in } : { start: duration - ticks.out, end: duration });
	}
	return dropUnusedBlur(next);
}

/** The shortest an out preset is squeezed to when its clip gets shorter; below it the preset goes. */
const MIN_SQUEEZED = 0.02 * TICKS_PER_SECOND;

/**
 * After the clip's length changed (a trim, a speed change), its out preset moves along so it still ends
 * with the clip. Without room (the in preset, or a keyframe of the clip's own on a property it animates,
 * would fall inside it) it is squeezed into the room left, its curves scaled in time, or removed below
 * MIN_SQUEEZED. Called before the animations are cut to the new length.
 */
export function reanchorOutPreset<T extends TimelineElement>(element: T, previousDuration: number): T {
	const end = element.duration;
	const keys = presetKeys(element.animations, "out");
	if (end === previousDuration || !keys.length) return element;
	const start = Math.min(...keys.map((key) => key.time));
	const length = previousDuration - start;
	const paths = [...new Set(keys.map((key) => key.path))];
	const own = paths.flatMap((path) => scalarKeys(element, path).filter((key) => !presetSideOf(key.id)).map((key) => key.time));
	// One of the clip's own at the new end would share its time with the preset's last key.
	if (own.some((time) => Math.abs(time - end) < 2)) return dropUnusedBlur(withoutPreset(element, "out"));
	const ownBefore = own.filter((time) => time < end);
	const earliest = Math.max(presetLength(element, "in") + 2, ownBefore.length ? Math.max(...ownBefore) + 2 : 0);
	const free = end - earliest;
	if (free < MIN_SQUEEZED || length <= 0) return dropUnusedBlur(withoutPreset(element, "out"));
	const scale = Math.min(1, free / length);
	const newStart = end - length * scale;
	let animations = element.animations;
	for (const path of paths) {
		const data = animations?.[path];
		if (!isLeafChannelData(data)) continue;
		const moved = (data.keys as ScalarAnimationKey[]).map((key) => {
			if (presetSideOf(key.id) !== "out") return key;
			const scaled = (handle: ScalarAnimationKey["leftHandle"]) => (handle && scale !== 1 ? { ...handle, dt: roundMediaTime({ time: handle.dt * scale }) as MediaTime } : handle);
			return { ...key, time: roundMediaTime({ time: newStart + (key.time - start) * scale }) as MediaTime, leftHandle: scaled(key.leftHandle), rightHandle: scaled(key.rightHandle) };
		});
		animations = { ...animations, [path]: { ...data, keys: moved.sort((a, b) => a.time - b.time) } as never };
	}
	return { ...element, animations };
}

/** Which preset each side of an element has now (from its keyframe ids), with its length in seconds. */
export function readAnimationPresets(element: TimelineElement): { in: { type: string; duration: number } | null; out: { type: string; duration: number } | null } {
	const read = (side: Side) => {
		const keys = presetKeys(element.animations, side);
		if (!keys.length) return null;
		const paths = new Set(keys.map((key) => key.path));
		const type =
			side === "in"
				? paths.has("typewriter") ? "typewriter" : paths.has(BLUR_PATH) ? "blur" : paths.has("transform.scaleX") ? (presetScaleStartsLarge(element) ? "impact" : "pop") : "fade"
				: paths.has(BLUR_PATH) ? "dissolve" : paths.has("transform.positionY") ? "fall" : "fade";
		return { type, duration: Math.round((presetLength(element, side) / TICKS_PER_SECOND) * 100) / 100 };
	};
	return { in: read("in"), out: read("out") };
}

function presetScaleStartsLarge(element: TimelineElement): boolean {
	const keys = scalarKeys(element, "transform.scaleX").filter((key) => presetSideOf(key.id) === "in");
	if (keys.length < 2) return false;
	return Number(keys[0].value) > Number(keys[keys.length - 1].value);
}

/** Whether a request (or the element) involves the preset blur effect (for stale-draft checks). */
export function touchesPresetBlur(element: TimelineElement, request: AnimationPresetRequest): boolean {
	return usesBlur("in", request.in?.type) || usesBlur("out", request.out?.type) || !!(element as { effects?: { id: string }[] }).effects?.some((effect) => effect.id === PRESET_BLUR_EFFECT_ID);
}
