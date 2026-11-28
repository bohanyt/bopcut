import { getElementParam } from "@/params/registry";
import type { ElementRef, TimelineElement } from "@/timeline/types";
import type { ElementUpdate } from "@/timeline/update-pipeline";

/** Never pasted: what a clip says, as opposed to how it looks or sounds. */
const NEVER_PASTED = new Set(["content"]);

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The attributes of a copied clip that "paste attributes" carries: its stored parameters that differ
 * from their defaults, without its text, media, timing, keyframes or anything a parameter writes
 * outside the parameters.
 */
export function changedAttributes(source: Omit<TimelineElement, "id"> & { id?: string }): Record<string, unknown> {
	if (!("params" in source) || !source.params) return {};
	const element = source as TimelineElement;
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source.params)) {
		if (NEVER_PASTED.has(key) || value === undefined) continue;
		const param = getElementParam({ element, key });
		if (!param || param.read || param.write || same(value, param.default)) continue;
		attributes[key] = value;
	}
	return attributes;
}

/** Whether a clip can take another's attributes: the same kind, and for a shape the same shape. */
function compatible(source: { type: string; definitionId?: unknown }, target: TimelineElement) {
	if (source.type !== target.type) return false;
	return source.type !== "graphic" || (target as { definitionId?: unknown }).definitionId === source.definitionId;
}

/** The updates that give each compatible target the source's changed attributes, and what was skipped. */
export function planPasteAttributes({ source, targets }: {
	source: Omit<TimelineElement, "id"> & { id?: string };
	targets: { track: { id: string }; element: TimelineElement }[];
}): { updates: ElementUpdate[]; keys: string[]; updated: ElementRef[]; skipped: ElementRef[] } {
	const attributes = changedAttributes(source);
	const keys = Object.keys(attributes);
	const updates: ElementUpdate[] = [];
	const updated: ElementRef[] = [];
	const skipped: ElementRef[] = [];
	for (const { track, element } of targets) {
		const ref = { trackId: track.id, elementId: element.id };
		if (!compatible(source as { type: string; definitionId?: unknown }, element) || !("params" in element)) {
			skipped.push(ref);
			continue;
		}
		const changed = Object.fromEntries(keys.filter((key) => !same(element.params[key], attributes[key])).map((key) => [key, attributes[key]]));
		updated.push(ref);
		if (Object.keys(changed).length) updates.push({ ...ref, patch: { params: changed } as Partial<TimelineElement> });
	}
	return { updates, keys, updated, skipped };
}
