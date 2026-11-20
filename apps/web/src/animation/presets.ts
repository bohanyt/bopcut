// In and out animation presets: a clip's settings (`animation.in`, `animation.inDuration`,
// `animation.out`, `animation.outDuration` params), drawn by the renderer on top of the clip's own
// opacity, transform and effects. They never touch the clip's keyframes, so trims, speed changes,
// splits and copies keep them: an in preset runs from the clip's start, an out preset up to its end.
import type { ParamValues } from "@/params";
import type { TimelineElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";

export const ANIMATION_IN_TYPES = ["fade", "pop", "impact", "blur", "typewriter"] as const;
export const ANIMATION_OUT_TYPES = ["fade", "fall", "dissolve"] as const;
export type AnimationInType = (typeof ANIMATION_IN_TYPES)[number];
export type AnimationOutType = (typeof ANIMATION_OUT_TYPES)[number];

/** Seconds each preset takes when no duration is given. */
export const DEFAULT_IN_SECONDS: Record<AnimationInType, number> = { fade: 0.3, pop: 0.35, impact: 0.25, blur: 0.4, typewriter: 1 };
export const DEFAULT_OUT_SECONDS: Record<AnimationOutType, number> = { fade: 0.3, fall: 0.5, dissolve: 0.5 };
export const MIN_PRESET_SECONDS = 0.05;
export const MAX_PRESET_SECONDS = 10;

export const PRESET_PARAM = {
	in: "animation.in",
	inDuration: "animation.inDuration",
	out: "animation.out",
	outDuration: "animation.outDuration",
} as const;

/** `none` removes that side's preset. */
export type AnimationPresetRequest = {
	in?: { type: AnimationInType | "none"; duration?: number };
	out?: { type: AnimationOutType | "none"; duration?: number };
};

export type PresetSettings = { in?: { type: AnimationInType; seconds: number }; out?: { type: AnimationOutType; seconds: number } };

const BLUR_AMOUNT = 30;

/** The presets in a clip's params (unknown or missing ones are none). */
export function readPresetSettings(params: ParamValues | undefined): PresetSettings {
	const side = <T extends string>(typeKey: string, durationKey: string, types: readonly T[], defaults: Record<T, number>) => {
		const type = params?.[typeKey];
		if (typeof type !== "string" || !types.includes(type as T)) return undefined;
		const raw = params?.[durationKey];
		const seconds = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(MAX_PRESET_SECONDS, raw) : defaults[type as T];
		return { type: type as T, seconds };
	};
	const settings: PresetSettings = {};
	const inSide = side(PRESET_PARAM.in, PRESET_PARAM.inDuration, ANIMATION_IN_TYPES, DEFAULT_IN_SECONDS);
	const outSide = side(PRESET_PARAM.out, PRESET_PARAM.outDuration, ANIMATION_OUT_TYPES, DEFAULT_OUT_SECONDS);
	if (inSide) settings.in = inSide;
	if (outSide) settings.out = outSide;
	return settings;
}

/** Which preset each side of a clip has, with its length in seconds. */
export function readAnimationPresets(element: TimelineElement): { in: { type: string; duration: number } | null; out: { type: string; duration: number } | null } {
	const { in: inSide, out } = readPresetSettings(element.params);
	return {
		in: inSide ? { type: inSide.type, duration: inSide.seconds } : null,
		out: out ? { type: out.type, duration: out.seconds } : null,
	};
}

/**
 * The clip with these presets (pure; the sides not asked about stay). Throws a message for a request the
 * clip cannot take: an unknown preset, a length out of range, typewriter on something other than text.
 */
export function applyAnimationPresets<T extends TimelineElement>(element: T, request: AnimationPresetRequest): T {
	const params: ParamValues = { ...element.params };
	for (const side of ["in", "out"] as const) {
		const spec = request[side];
		if (!spec) continue;
		const types: readonly string[] = side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES;
		if (spec.type !== "none" && !types.includes(spec.type)) throw new Error(`${side} animation must be one of ${types.join(", ")} or none`);
		if (spec.type !== "none" && (element.type === "audio" || element.type === "effect")) throw new Error(`animations are for visual clips, not ${element.type}`);
		if (spec.type === "typewriter" && element.type !== "text") throw new Error("typewriter is for text");
		if (spec.duration !== undefined && (typeof spec.duration !== "number" || !Number.isFinite(spec.duration) || spec.duration < MIN_PRESET_SECONDS || spec.duration > MAX_PRESET_SECONDS)) {
			throw new Error(`${side} animation duration must be ${MIN_PRESET_SECONDS} to ${MAX_PRESET_SECONDS} seconds`);
		}
		const typeKey = side === "in" ? PRESET_PARAM.in : PRESET_PARAM.out;
		const durationKey = side === "in" ? PRESET_PARAM.inDuration : PRESET_PARAM.outDuration;
		if (spec.type === "none") {
			// Written, not deleted: element updates merge params, so a deleted key would come back.
			params[typeKey] = "none";
			continue;
		}
		params[typeKey] = spec.type;
		params[durationKey] = spec.duration ?? (side === "in" ? DEFAULT_IN_SECONDS[spec.type as AnimationInType] : DEFAULT_OUT_SECONDS[spec.type as AnimationOutType]);
	}
	return { ...element, params };
}

/**
 * Checks preset values written as raw params (an agent's `params`), the same way as a request: throws a
 * message for a value a preset cannot have.
 */
export function checkPresetParams(element: TimelineElement, params: ParamValues | undefined): void {
	if (!params || !Object.values(PRESET_PARAM).some((key) => key in params)) return;
	const merged = { ...element.params, ...params };
	const side = (name: "in" | "out", typeKey: string, durationKey: string) => {
		if (!(typeKey in params) && !(durationKey in params)) return undefined;
		// Every value given is checked, also a length next to "none".
		if (typeKey in params && typeof params[typeKey] !== "string") throw new Error(`${typeKey} must be a preset name or "none"`);
		const duration = durationKey in params ? params[durationKey] : merged[durationKey];
		if (durationKey in params && (typeof duration !== "number" || !Number.isFinite(duration) || duration < MIN_PRESET_SECONDS || duration > MAX_PRESET_SECONDS)) {
			throw new Error(`${name} animation duration must be ${MIN_PRESET_SECONDS} to ${MAX_PRESET_SECONDS} seconds`);
		}
		const type = typeof merged[typeKey] === "string" ? merged[typeKey] : "none";
		return { type, ...(duration === undefined || type === "none" ? {} : { duration }) };
	};
	applyAnimationPresets(element, {
		in: side("in", PRESET_PARAM.in, PRESET_PARAM.inDuration),
		out: side("out", PRESET_PARAM.out, PRESET_PARAM.outDuration),
	} as AnimationPresetRequest);
}

/** The params of a clip whose start (`in`) or end (`out`) was cut off: that side's preset goes, like a split. */
export function withoutPresetSide(params: ParamValues, side: "in" | "out"): ParamValues {
	const key = side === "in" ? PRESET_PARAM.in : PRESET_PARAM.out;
	return typeof params[key] === "string" && params[key] !== "none" ? { ...params, [key]: "none" } : params;
}

/** What the presets add at a moment: factors for opacity and scale, offsets for position and rotation, a blur and the share of letters typed. */
export type PresetLayer = { opacity: number; scale: number; offsetY: number; rotate: number; blur: number; typed: number };
export const NO_PRESET_LAYER: PresetLayer = { opacity: 1, scale: 1, offsetY: 0, rotate: 0, blur: 0, typed: 1 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/**
 * The presets' effect at `localTime` (ticks from the clip's start) of a clip `duration` ticks long. Both
 * sides are shortened alike when they would not fit.
 */
export function presetLayerAt(settings: PresetSettings, localTime: number, duration: number, canvasHeight: number): PresetLayer {
	if (!settings.in && !settings.out) return NO_PRESET_LAYER;
	let inTicks = (settings.in?.seconds ?? 0) * TICKS_PER_SECOND;
	let outTicks = (settings.out?.seconds ?? 0) * TICKS_PER_SECOND;
	// Shortened to fit, the presets leave the clip whole for a moment (a tenth, at least a frame at 24 fps),
	// so an in preset is complete on a frame that is drawn (the clip's end itself is not).
	const room = Math.max(0, duration - Math.max(duration * 0.1, TICKS_PER_SECOND / 24));
	if (inTicks + outTicks > room && inTicks + outTicks > 0) {
		const fit = room / (inTicks + outTicks);
		inTicks *= fit;
		outTicks *= fit;
	}
	const layer = { ...NO_PRESET_LAYER };
	if (settings.in && inTicks > 0 && localTime < inTicks) {
		const p = clamp01(localTime / inTicks);
		const fadeBy = (end: number) => easeOut(clamp01(p / end));
		switch (settings.in.type) {
			case "fade":
				layer.opacity *= fadeBy(1);
				break;
			case "pop":
				// Grows past its size, then settles.
				layer.opacity *= fadeBy(0.4);
				layer.scale *= p < 0.65 ? lerp(0.5, 1.1, easeOut(p / 0.65)) : lerp(1.1, 1, easeInOut((p - 0.65) / 0.35));
				break;
			case "impact":
				// Comes down from large and lands hard.
				layer.opacity *= fadeBy(0.3);
				layer.scale *= lerp(1.6, 1, easeIn(p));
				break;
			case "blur":
				layer.opacity *= fadeBy(0.5);
				layer.blur += BLUR_AMOUNT * (1 - easeOut(p));
				break;
			case "typewriter":
				layer.typed = p;
				break;
		}
	}
	const outStart = duration - outTicks;
	if (settings.out && outTicks > 0 && localTime > outStart) {
		const q = clamp01((localTime - outStart) / outTicks);
		switch (settings.out.type) {
			case "fade":
				layer.opacity *= 1 - easeIn(q);
				break;
			case "fall":
				// Drops a quarter of the canvas and tips over while it fades.
				layer.offsetY += canvasHeight * 0.25 * easeIn(q);
				layer.rotate += 8 * easeIn(q);
				layer.opacity *= 1 - easeIn(clamp01((q - 0.3) / 0.7));
				break;
			case "dissolve":
				layer.blur += BLUR_AMOUNT * easeIn(q);
				layer.scale *= 1 + 0.05 * easeOut(q);
				layer.opacity *= 1 - easeIn(q);
				break;
		}
	}
	return layer;
}
