// In and out animation presets for agents: `animate:{in:"pop", out:{type:"fade", duration:0.4}}` on an
// element (bundles, draft add) and the draft op `{op:"animate", match, in?, out?}`. See animation/presets.
import {
	ANIMATION_IN_TYPES,
	ANIMATION_OUT_TYPES,
	type AnimationPresetRequest,
	MAX_PRESET_SECONDS,
	MIN_PRESET_SECONDS,
	PRESET_PARAM,
	applyAnimationPresets,
	readAnimationPresets,
} from "@/animation/presets";
import type { TimelineElement } from "@/timeline";

/** A preset name, or a name and its length in seconds; `none` removes that side's preset. */
export type AgentAnimateSide = string | { type: string; duration?: number };
export type AgentAnimate = { in?: AgentAnimateSide; out?: AgentAnimateSide };

function side(name: "in" | "out", value: unknown): { type: string; duration?: number } | undefined {
	if (value === undefined) return undefined;
	const spec = typeof value === "string" ? { type: value } : value;
	const types: readonly string[] = name === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES;
	if (!spec || typeof spec !== "object" || typeof (spec as { type?: unknown }).type !== "string" || (!types.includes((spec as { type: string }).type) && (spec as { type: string }).type !== "none")) {
		throw new Error(`animate.${name} must be one of ${types.join(", ")} or none (a name, or {type, duration})`);
	}
	const { type, duration } = spec as { type: string; duration?: unknown };
	if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < MIN_PRESET_SECONDS || duration > MAX_PRESET_SECONDS)) {
		throw new Error(`animate.${name}.duration must be ${MIN_PRESET_SECONDS} to ${MAX_PRESET_SECONDS} seconds`);
	}
	return duration === undefined ? { type } : { type, duration: duration as number };
}

/** The checked request; throws a message an agent can act on. */
export function parseAgentAnimate(value: unknown): AnimationPresetRequest {
	if (!value || typeof value !== "object") throw new Error("animate must be {in?, out?}");
	const raw = value as Record<string, unknown>;
	const request = { in: side("in", raw.in), out: side("out", raw.out) } as AnimationPresetRequest;
	if (!request.in && !request.out) throw new Error("animate needs in or out");
	return request;
}

/** Applies an agent's animate request (raw or parsed) to an element (pure); only visual clips animate. */
export function animateAgentElement<T extends TimelineElement>(element: T, value: unknown): T {
	if (element.type === "audio" || element.type === "effect") throw new Error(`animate is for visual clips, not ${element.type}`);
	return applyAnimationPresets(element, parseAgentAnimate(value));
}

/** The params a request changes (for stale-draft checks). */
export function animateParams(request: AnimationPresetRequest): string[] {
	return [
		...(request.in ? [PRESET_PARAM.in, PRESET_PARAM.inDuration] : []),
		...(request.out ? [PRESET_PARAM.out, PRESET_PARAM.outDuration] : []),
	];
}

export { readAnimationPresets };
