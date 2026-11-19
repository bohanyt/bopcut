// Camera shake: a deterministic offset added on top of an element's own transform (position, zoom and
// rotation keyframes stay as the user set them). Intensity can be keyframed, so a hit can decay.
import { resolveAnimationPathValueAtTime } from "@/animation";
import { getElementKeyframes } from "@/animation/keyframe-query";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import type { Transform } from "./index";

export type ShakeSettings = {
	/** Maximum offset in project pixels; 0 = no shake. Keyframable as `shake.intensity`. */
	intensity: number;
	/** Shakes per second. */
	frequency: number;
	/** Maximum rotation in degrees, reached at the element's peak intensity; it follows a keyframed intensity down. */
	rotation: number;
	/** Changes the pattern; the same seed always shakes the same way. */
	seed: number;
};

export const SHAKE_DEFAULTS: ShakeSettings = { intensity: 0, frequency: 8, rotation: 0, seed: 1 };

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function readShakeSettings(params: ParamValues): ShakeSettings | undefined {
	const intensity = num(params["shake.intensity"], 0);
	const rotation = num(params["shake.rotation"], 0);
	return {
		intensity: Math.max(0, intensity),
		frequency: Math.min(60, Math.max(0.1, num(params["shake.frequency"], SHAKE_DEFAULTS.frequency))),
		rotation: Math.max(0, rotation),
		seed: Math.round(num(params["shake.seed"], SHAKE_DEFAULTS.seed)),
	};
}

const phaseCache = new Map<number, number[]>();

/** Deterministic phases per seed (a small hash, so seeds 1, 2, 3 look unrelated); computed once per seed. */
function phases(seed: number): number[] {
	const cached = phaseCache.get(seed);
	if (cached) return cached;
	let h = (seed * 2654435761) >>> 0;
	const result = Array.from({ length: 6 }, () => {
		h = (h ^ (h >>> 13)) >>> 0;
		h = Math.imul(h, 0x5bd1e995) >>> 0;
		return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
	});
	if (phaseCache.size >= 256) phaseCache.clear();
	phaseCache.set(seed, result);
	return result;
}

const keyframePeakCache = new WeakMap<ElementAnimations, number>();

/** The strongest intensity the element reaches: its base value or its highest intensity keyframe. */
export function peakShakeIntensity(settings: ShakeSettings, animations: ElementAnimations | undefined): number {
	if (!animations) return settings.intensity;
	let keyframePeak = keyframePeakCache.get(animations);
	if (keyframePeak === undefined) {
		keyframePeak = 0;
		for (const keyframe of getElementKeyframes({ animations })) {
			if (keyframe.propertyPath === "shake.intensity" && typeof keyframe.value === "number" && Number.isFinite(keyframe.value)) {
				keyframePeak = Math.max(keyframePeak, keyframe.value);
			}
		}
		keyframePeakCache.set(animations, keyframePeak);
	}
	return Math.max(settings.intensity, keyframePeak);
}

/**
 * Offset at `seconds`: two incommensurate sines per axis, so it does not read as a loop. Rotation scales with
 * `intensity / peak` (at most 1), so the full rotation is reached only at the peak intensity.
 */
export function shakeOffset(
	settings: ShakeSettings,
	seconds: number,
	intensity = settings.intensity,
	peak = Math.max(settings.intensity, intensity),
): { x: number; y: number; rotate: number } {
	if (intensity <= 0) return { x: 0, y: 0, rotate: 0 };
	const p = phases(settings.seed);
	const w = 2 * Math.PI * settings.frequency * seconds;
	const x = 0.62 * Math.sin(w + p[0]) + 0.38 * Math.sin(w * 1.73 + p[1]);
	const y = 0.62 * Math.sin(w * 1.11 + p[2]) + 0.38 * Math.sin(w * 2.07 + p[3]);
	const r = 0.6 * Math.sin(w * 0.93 + p[4]) + 0.4 * Math.sin(w * 1.61 + p[5]);
	const rotationScale = peak > 0 ? Math.min(1, Math.max(0, intensity / peak)) : 0;
	return { x: x * intensity, y: y * intensity, rotate: r * settings.rotation * rotationScale };
}

/** The transform with the shake added at `localTime` (ticks, element-relative); unchanged without shake. */
export function applyShake({
	transform,
	settings,
	animations,
	localTime,
	ticksPerSecond,
}: {
	transform: Transform;
	settings: ShakeSettings | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
	ticksPerSecond: number;
}): Transform {
	if (!settings) return transform;
	const intensity = Math.max(
		0,
		resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "shake.intensity",
			localTime: Math.max(0, localTime),
			fallbackValue: settings.intensity,
		}) as number,
	);
	if (intensity <= 0) return transform;
	const offset = shakeOffset(settings, localTime / ticksPerSecond, intensity, peakShakeIntensity(settings, animations));
	return {
		...transform,
		position: { x: transform.position.x + offset.x, y: transform.position.y + offset.y },
		rotate: transform.rotate + offset.rotate,
	};
}
