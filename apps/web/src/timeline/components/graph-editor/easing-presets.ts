import type { StaticMessageKey } from "@/i18n/translate";
import type { NormalizedCubicBezier } from "@/animation/types";

export const PRESET_MATCH_TOLERANCE = 0.02;

export interface EasingPreset {
	id: string;
	label: string;
	value: NormalizedCubicBezier;
	isCustom?: boolean;
}

export const BUILTIN_PRESETS: (Omit<EasingPreset, "label"> & { labelKey: StaticMessageKey })[] = [
	{ id: "smooth", labelKey: "graph.smooth", value: [0.25, 0.1, 0.25, 1] },
	{ id: "ease-out", labelKey: "graph.easeOut", value: [0, 0, 0.2, 1] },
	{ id: "ease-in", labelKey: "graph.easeIn", value: [0.8, 0, 1, 1] },
	{ id: "ease-in-out", labelKey: "graph.easeInOut", value: [0.4, 0, 0.2, 1] },
	{ id: "pop", labelKey: "graph.pop", value: [0.175, 0.885, 0.32, 1.275] },
	{ id: "linear", labelKey: "graph.linear", value: [0, 0, 1, 1] },
];
