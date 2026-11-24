import type { StaticMessageKey } from "@/i18n/translate";
import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { parseEffectParamPath } from "@/animation";
import { effectsRegistry } from "@/effects";
import { graphicsRegistry } from "@/graphics";
import { getElementParams } from "@/params/registry";
import { getElementKeyframes } from "@/animation";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";

export interface ExpandedRow {
	propertyPath: AnimationPath;
	labelKey?: StaticMessageKey;
	fallbackLabel?: string;
}

interface PropertyGroupDefinition {
	matchesPath: (path: AnimationPath) => boolean;
}

const PROPERTY_GROUPS: PropertyGroupDefinition[] = [
	{ matchesPath: (path) => path.startsWith("transform.") || path === "opacity" },
	{ matchesPath: (path) => path === "volume" || path === "color" },
	{ matchesPath: (path) => path.startsWith("background.") },
	{ matchesPath: (path) => path.startsWith("params.") },
	{ matchesPath: (path) => path.startsWith("effects.") },
];

const PROPERTY_LABELS: Partial<Record<string, StaticMessageKey>> = {
	"transform.positionX": "params.positionX",
	"transform.positionY": "params.positionY",
	"transform.scaleX": "params.scaleX",
	"transform.scaleY": "params.scaleY",
	"transform.rotate": "params.rotation",
	opacity: "params.opacity",
	volume: "params.volume",
	color: "common.color",
	"background.color": "timeline.bgColor",
	"background.paddingX": "timeline.bgPadX",
	"background.paddingY": "timeline.bgPadY",
	"background.offsetX": "timeline.bgOffsetX",
	"background.offsetY": "timeline.bgOffsetY",
	"background.cornerRadius": "params.cornerRadius",
	"shake.intensity": "timeline.shake",
	typewriter: "params.typed",
};

function getExpandedRow(element: TimelineElement, path: AnimationPath): ExpandedRow {
	const effectPath = parseEffectParamPath({ propertyPath: path });
	if (effectPath) {
		const effect = "effects" in element && element.effects?.find(({ id }) => id === effectPath.effectId);
		const definition = effect && effectsRegistry.has(effect.type) ? effectsRegistry.get(effect.type) : undefined;
		const param = definition?.params.find(({ key }) => key === effectPath.paramKey);
		return { propertyPath: path, labelKey: param?.labelKey, fallbackLabel: effectPath.paramKey };
	}
	if (element.type === "graphic" && path.startsWith("params.")) {
		const paramKey = path.slice("params.".length);
		const definition = graphicsRegistry.has(element.definitionId) ? graphicsRegistry.get(element.definitionId) : undefined;
		const param = definition?.params.find(({ key }) => key === paramKey);
		return { propertyPath: path, labelKey: param?.labelKey, fallbackLabel: paramKey };
	}
	const labelKey = PROPERTY_LABELS[path] ?? getElementParams({ element }).find(({ key }) => key === path)?.labelKey;
	return { propertyPath: path, labelKey };
}

export function getExpandedRows({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ExpandedRow[] {
	const keyframes = getElementKeyframes({ animations });
	const propertyPaths = [...new Set(keyframes.map((kf) => kf.propertyPath))];
	if (propertyPaths.length === 0) return [];

	const rows: ExpandedRow[] = [];

	for (const group of PROPERTY_GROUPS) {
		const groupPaths = propertyPaths.filter((path) =>
			group.matchesPath(path),
		);
		for (const path of groupPaths) {
			rows.push({ propertyPath: path });
		}
	}

	return rows;
}

export function getExpansionHeight({ rows }: { rows: ExpandedRow[] }): number {
	return rows.length * KEYFRAME_LANE_HEIGHT_PX;
}

export function computeTrackExpansionHeight({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): number {
	if (expandedElementIds.size === 0) return 0;
	let maxHeight = 0;
	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		maxHeight = Math.max(maxHeight, getExpansionHeight({ rows }));
	}
	return maxHeight;
}

export function getTrackExpandedRows({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): ExpandedRow[] {
	if (expandedElementIds.size === 0) return [];
	let maxHeight = 0;
	let maxRows: ExpandedRow[] = [];
	let expandedElement: TimelineElement | undefined;

	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		const height = getExpansionHeight({ rows });
		if (height > maxHeight) {
			maxHeight = height;
			maxRows = rows;
			expandedElement = element;
		}
	}

	return expandedElement
		? maxRows.map(({ propertyPath }) => getExpandedRow(expandedElement, propertyPath))
		: maxRows;
}
