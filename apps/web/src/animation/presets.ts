// In and out animation presets, written as ordinary keyframes (and, for blur, a blur effect) that stay
// editable. Their keyframe ids start with `anim-in-` / `anim-out-`, so applying a preset again replaces
// the earlier preset's keyframes and never the user's own.
import type { ElementAnimations, NormalizedCubicBezier } from "@/animation/types";
import { getCurveHandlesForNormalizedCubicBezier } from "@/animation/curve-bridge";
import { getChannelsFromData } from "@/animation/channel-data";
import { removeElementKeyframe, updateScalarKeyframeCurve, upsertPathKeyframe } from "@/animation/keyframes";
import { resolveAnimationPathValueAtTime } from "@/animation/resolve";
import { buildEffectParamPath } from "@/animation/effect-param-channel";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
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
/** One animated property of a preset: values at points of its window (0 = window start, 1 = end). */
type Track = { path: string; points: { at: number; value: (edge: number) => number; ease?: NormalizedCubicBezier }[] };

const prefix = (side: Side) => `anim-${side}-`;

/** The tracks of a preset. `edge` is the property's own value where the preset meets the rest of the clip. */
function presetTracks(side: Side, type: string, canvasHeight: number): Track[] {
	const to = (value: number) => () => value;
	const own = (edge: number) => edge;
	const times = (factor: number) => (edge: number) => edge * factor;
	const opacityIn = (end: number): Track => ({ path: "opacity", points: [{ at: 0, value: to(0), ease: EASE_OUT }, { at: end, value: own }] });
	const opacityOut = (start: number): Track => ({ path: "opacity", points: [{ at: start, value: own, ease: EASE_IN }, { at: 1, value: to(0) }] });
	const scale = (points: Track["points"]): Track[] => ["transform.scaleX", "transform.scaleY"].map((path) => ({ path, points }));
	if (side === "in") {
		switch (type) {
			case "fade":
				return [opacityIn(1)];
			case "pop":
				// Grows past its size, then settles.
				return [opacityIn(0.4), ...scale([{ at: 0, value: times(0.5), ease: EASE_OUT }, { at: 0.65, value: times(1.1), ease: EASE_IN_OUT }, { at: 1, value: own }])];
			case "impact":
				// Comes down from large and lands hard.
				return [opacityIn(0.3), ...scale([{ at: 0, value: times(1.6), ease: EASE_IN }, { at: 1, value: own }])];
			case "blur":
				return [opacityIn(0.5), { path: BLUR_PATH, points: [{ at: 0, value: to(BLUR_AMOUNT), ease: EASE_OUT }, { at: 1, value: own }] }];
			case "typewriter":
				return [{ path: "typewriter", points: [{ at: 0, value: to(0) }, { at: 1, value: own }] }];
		}
	} else {
		switch (type) {
			case "fade":
				return [opacityOut(0)];
			case "fall":
				// Drops and tips over while it fades.
				return [
					opacityOut(0.3),
					{ path: "transform.positionY", points: [{ at: 0, value: own, ease: EASE_IN }, { at: 1, value: (edge) => edge + canvasHeight * 0.25 }] },
					{ path: "transform.rotate", points: [{ at: 0, value: own, ease: EASE_IN }, { at: 1, value: (edge) => edge + 8 }] },
				];
			case "dissolve":
				return [
					opacityOut(0),
					{ path: BLUR_PATH, points: [{ at: 0, value: own, ease: EASE_IN }, { at: 1, value: to(BLUR_AMOUNT) }] },
					...scale([{ at: 0, value: own, ease: EASE_OUT }, { at: 1, value: times(1.05) }]),
				];
		}
	}
	throw new Error(`unknown ${side} animation: ${type}`);
}

/** Every keyframe of the element whose id marks it as one side's preset, as path and id. */
function presetKeys(animations: ElementAnimations | undefined, side: Side): { path: string; id: string }[] {
	const found: { path: string; id: string }[] = [];
	for (const [path, data] of Object.entries(animations ?? {})) {
		if (!data) continue;
		for (const channel of getChannelsFromData({ data })) {
			for (const key of channel?.keys ?? []) if (key.id.startsWith(prefix(side)) && !found.some((f) => f.path === path && f.id === key.id)) found.push({ path, id: key.id });
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

function writeTracks<T extends TimelineElement>(element: T, side: Side, tracks: Track[], window: { start: number; end: number }): T {
	let next = element;
	const span = window.end - window.start;
	// Each property's own value where the preset meets the rest of the clip (taken before anything is written).
	const edges = new Map(tracks.map((track) => [track.path, valueAt(element, track.path, side === "in" ? window.end : window.start)]));
	let n = 0;
	for (const track of tracks) {
		const target = resolveAnimationTarget({ element: next, path: track.path });
		if (!target) continue; // the element has no such property (for example typewriter on a video)
		const edge = edges.get(track.path) ?? 0;
		const ids: string[] = [];
		for (const point of track.points) {
			const id = `${prefix(side)}${track.path}-${n++}`;
			ids.push(id);
			const time = roundMediaTime({ time: window.start + span * point.at }) as MediaTime;
			let animations = upsertPathKeyframe({
				animations: next.animations, propertyPath: track.path, time,
				value: point.value(edge), interpolation: point.ease ? "bezier" : "linear", keyframeId: id,
				channelLayout: target.channelLayout, coerceValue: target.coerceValue,
			});
			// A keyframe of the user's at that very time was written over: it is the preset's now.
			const channel = getChannelsFromData({ data: animations?.[track.path] as never })[0];
			const taken = channel?.keys.find((key) => Math.abs(key.time - time) < 1 && key.id !== id && !key.id.startsWith("anim-"));
			if (channel && taken && !channel.keys.some((key) => key.id === id)) {
				animations = { ...animations, [track.path]: { ...channel, keys: channel.keys.map((key) => (key === taken ? { ...key, id } : key)) } as never };
			}
			next = { ...next, animations };
		}
		// Easing: the curve of each segment that has one.
		track.points.forEach((point, index) => {
			if (!point.ease || index + 1 >= track.points.length) return;
			const channel = getChannelsFromData({ data: next.animations?.[track.path] as never })[0];
			const left = channel?.keys.find((key) => key.id === ids[index]);
			const right = channel?.keys.find((key) => key.id === ids[index + 1]);
			if (!left || !right || typeof left.value !== "number" || typeof right.value !== "number") return;
			const handles = getCurveHandlesForNormalizedCubicBezier({ leftKey: left as never, rightKey: right as never, cubicBezier: point.ease, referenceSpanValue: 1 });
			if (!handles) return;
			let animations = updateScalarKeyframeCurve({ animations: next.animations, propertyPath: track.path, componentKey: "value", keyframeId: left.id, patch: { rightHandle: handles.rightHandle, segmentToNext: "bezier", tangentMode: "broken" } });
			animations = updateScalarKeyframeCurve({ animations, propertyPath: track.path, componentKey: "value", keyframeId: right.id, patch: { leftHandle: handles.leftHandle, tangentMode: "broken" } });
			next = { ...next, animations };
		});
	}
	return next;
}

/**
 * Applies in and out presets to an element (pure). Each side replaces that side's earlier preset; keyframes
 * of the user's own are kept, and the preset starts and ends at the values they give. If both sides would
 * overlap, they are shortened to fit the clip.
 */
export function applyAnimationPresets<T extends TimelineElement>(element: T, request: AnimationPresetRequest, { canvasHeight }: { canvasHeight: number }): T {
	const duration = element.duration;
	const seconds = (side: Side) => {
		const spec = request[side];
		if (!spec || spec.type === "none") return 0;
		const fallback = side === "in" ? DEFAULT_IN_SECONDS[spec.type as AnimationInType] : DEFAULT_OUT_SECONDS[spec.type as AnimationOutType];
		const wanted = spec.duration ?? fallback;
		if (typeof wanted !== "number" || !Number.isFinite(wanted) || wanted <= 0 || wanted > 10) throw new Error(`${side} animation duration must be 0 to 10 seconds`);
		return wanted * TICKS_PER_SECOND;
	};
	for (const side of ["in", "out"] as const) {
		const spec = request[side];
		if (!spec) continue;
		const types: readonly string[] = side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES;
		if (spec.type !== "none" && !types.includes(spec.type)) throw new Error(`${side} animation must be one of ${types.join(", ")} or none`);
		if (side === "in" && spec.type === "typewriter" && element.type !== "text") throw new Error("typewriter is for text");
	}
	let inTicks = seconds("in");
	let outTicks = seconds("out");
	// The side not asked about keeps its preset; its length counts when the two would overlap.
	const kept = (side: Side) => {
		const keys = presetKeys(element.animations, side);
		if (!keys.length) return 0;
		const times = keys.flatMap(({ path, id }) => getChannelsFromData({ data: element.animations?.[path] as never }).flatMap((channel) => channel?.keys.filter((key) => key.id === id).map((key) => key.time) ?? []));
		return side === "in" ? Math.max(...times) : duration - Math.min(...times);
	};
	if (!request.in) inTicks = 0;
	if (!request.out) outTicks = 0;
	const otherIn = request.in ? inTicks : kept("in");
	const otherOut = request.out ? outTicks : kept("out");
	// The two sides never meet at one time (a channel has one keyframe per time): a tick stays between them.
	const room = duration - 2;
	if (otherIn + otherOut > room) {
		if (request.in && request.out) {
			const scale = Math.max(0, room) / (otherIn + otherOut);
			inTicks *= scale;
			outTicks *= scale;
		} else if (request.in) {
			// The out side keeps its preset; the new one gets the room left.
			inTicks = Math.max(0, room - otherOut);
		} else {
			outTicks = Math.max(0, room - otherIn);
		}
	}
	let next = element;
	for (const side of ["in", "out"] as const) {
		const spec = request[side];
		if (!spec) continue;
		next = withoutPreset(next, side);
		if (spec.type === "none") continue;
		const tracks = presetTracks(side, spec.type, canvasHeight);
		if (tracks.some((track) => track.path === BLUR_PATH)) next = withPresetBlur(next);
		const ticks = side === "in" ? inTicks : outTicks;
		if (ticks < 1) continue;
		next = writeTracks(next, side, tracks, side === "in" ? { start: 0, end: ticks } : { start: duration - ticks, end: duration });
	}
	return dropUnusedBlur(next);
}

/** Which preset each side of an element has now (from its keyframe ids), with its length in seconds. */
export function readAnimationPresets(element: TimelineElement): { in: { type: string; duration: number } | null; out: { type: string; duration: number } | null } {
	const read = (side: Side) => {
		const keys = presetKeys(element.animations, side);
		if (!keys.length) return null;
		const paths = new Set(keys.map((key) => key.path));
		const times = keys.flatMap(({ path, id }) => getChannelsFromData({ data: element.animations?.[path] as never }).flatMap((channel) => channel?.keys.filter((key) => key.id === id).map((key) => key.time) ?? []));
		const length = side === "in" ? Math.max(...times) : element.duration - Math.min(...times);
		const type =
			side === "in"
				? paths.has("typewriter") ? "typewriter" : paths.has(BLUR_PATH) ? "blur" : paths.has("transform.scaleX") ? (presetScaleStartsLarge(element) ? "impact" : "pop") : "fade"
				: paths.has(BLUR_PATH) ? "dissolve" : paths.has("transform.positionY") ? "fall" : "fade";
		return { type, duration: Math.round((length / TICKS_PER_SECOND) * 100) / 100 };
	};
	return { in: read("in"), out: read("out") };
}

function presetScaleStartsLarge(element: TimelineElement): boolean {
	const channel = getChannelsFromData({ data: element.animations?.["transform.scaleX"] as never })[0];
	const keys = (channel?.keys ?? []).filter((key) => key.id.startsWith(prefix("in")));
	if (keys.length < 2) return false;
	const first = keys.reduce((a, b) => (a.time <= b.time ? a : b));
	const last = keys.reduce((a, b) => (a.time >= b.time ? a : b));
	return Number(first.value) > Number(last.value);
}
