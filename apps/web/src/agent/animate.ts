// In and out animation presets for agents: `animate:{in:"pop", out:{type:"fade", duration:0.4}}` on an
// element (bundles, draft add) and the draft op `{op:"animate", match, in?, out?}`. See animation/presets.
import {
	ANIMATION_IN_TYPES,
	ANIMATION_OUT_TYPES,
	type AnimationPresetRequest,
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
	if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 10)) throw new Error(`animate.${name}.duration must be 0 to 10 seconds`);
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

/** Applies an agent's animate request to an element (pure); only visual clips animate. */
export function animateAgentElement<T extends TimelineElement>(element: T, value: unknown, canvasHeight: number): T {
	if (element.type === "audio" || element.type === "effect") throw new Error(`animate is for visual clips, not ${element.type}`);
	return applyAnimationPresets(element, parseAgentAnimate(value), { canvasHeight });
}

export { readAnimationPresets };
