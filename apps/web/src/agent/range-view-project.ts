import { collectAudibleCandidates } from "@/media/audio";
import type { MediaAsset } from "@/media/types";
import { getFontFamiliesForElements } from "@/timeline/element-utils";
import { isElementMuted } from "@/timeline/audio-state";
import type { CompoundElement, TimelineElement, TimelineTrack, TScene } from "@/timeline";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import type { RangeInput } from "./range-view";
import { orderedTracks, toRootInterval } from "./scene-graph";

export function* visibleRangeElements(root: TScene, scenes: TScene[], { from, to }: RangeInput) {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	function* visit(scene: TScene, chain: CompoundElement[], seen: Set<string>): Generator<{
		element: TimelineElement; start: number; end: number; chain: CompoundElement[]; track: TimelineTrack;
	}> {
		if (seen.has(scene.id) || chain.length > 32) return;
		const ancestors = new Set(seen).add(scene.id);
		for (const track of orderedTracks(scene.tracks)) {
			if ("hidden" in track && track.hidden) continue;
			for (const element of track.elements) {
				if ("hidden" in element && element.hidden) continue;
				const interval = toRootInterval(element.startTime, element.startTime + element.duration, chain);
				if (!interval) continue;
				const start = interval[0] / TICKS_PER_SECOND, end = interval[1] / TICKS_PER_SECOND;
				if (start >= to || end <= from || end <= start) continue;
				yield { element, start, end, chain, track };
				if (element.type === "compound") {
					const nested = byId.get(element.sceneId);
					if (nested) yield* visit(nested, [...chain, element], ancestors);
				}
			}
		}
	}
	yield* visit(root, [], new Set());
}

export function rangeFontFamilies(root: TScene, scenes: TScene[], input: RangeInput) {
	const elements = Array.from(visibleRangeElements(root, scenes, input), ({ element }) => element);
	return getFontFamiliesForElements(elements);
}

export function needsExternalRenderAudio(root: TScene, scenes: TScene[], mediaAssets: MediaAsset[], input?: RangeInput) {
	return collectAudibleCandidates({
		tracks: root.tracks, scenes, mediaAssets,
		...(input && {
			rangeStart: mediaTimeFromSeconds({ seconds: input.from }),
			duration: mediaTimeFromSeconds({ seconds: input.to }),
		}),
	}).some(({ element }) => element.type === "audio" && element.sourceType === "library" &&
		!isElementMuted({ element }) && !/^\/api\/agent\/(?:sfx|music)-file\?/.test(element.sourceUrl ?? ""));
}
