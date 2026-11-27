import type { SceneTracks } from "@/timeline";
import {
	buildSnapIndex,
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveIndexedSnap,
	type SnapIndex,
	type SnapPoint,
} from "@/timeline/snapping";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import type { MoveGroup } from "./types";
import { addMediaTime, type MediaTime, subMediaTime } from "@/wasm";

/** What the group's edges can snap to: other clips' edges, the playhead and keyframes. Reusable while they do not change. */
export function buildGroupSnapIndex({
	group,
	tracks,
	playheadTime,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	playheadTime: MediaTime;
}): SnapIndex {
	const excludeElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	return buildSnapIndex({
		points: buildTimelineSnapPoints({
			sources: [
				() => getElementEdgeSnapPoints({ tracks, excludeElementIds }),
				() => getPlayheadSnapPoints({ playheadTime }),
				() =>
					getAnimationKeyframeSnapPointsForTimeline({
						tracks,
						excludeElementIds,
					}),
			],
		}),
	});
}

export function snapGroupEdges({
	group,
	anchorStartTime,
	tracks,
	playheadTime,
	zoomLevel,
	index = buildGroupSnapIndex({ group, tracks, playheadTime }),
}: {
	group: MoveGroup;
	anchorStartTime: MediaTime;
	tracks: SceneTracks;
	playheadTime: MediaTime;
	zoomLevel: number;
	/** From `buildGroupSnapIndex` for the same group, tracks and playhead. */
	index?: SnapIndex;
}): {
	snappedAnchorStartTime: MediaTime;
	snapPoint: SnapPoint | null;
} {
	const maxSnapDistance = getTimelineSnapThresholdInTicks({ zoomLevel });

	let closestSnapDistance = Infinity;
	let snappedAnchorStartTime = anchorStartTime;
	let snapPoint: SnapPoint | null = null;

	for (const member of group.members) {
		const memberStartTime = addMediaTime({
			a: anchorStartTime,
			b: member.timeOffset,
		});
		const memberStartSnap = resolveIndexedSnap({
			targetTime: memberStartTime,
			index,
			maxSnapDistance,
		});
		if (
			memberStartSnap.snapPoint &&
			memberStartSnap.snapDistance < closestSnapDistance
		) {
			closestSnapDistance = memberStartSnap.snapDistance;
			snappedAnchorStartTime = subMediaTime({
				a: memberStartSnap.snappedTime,
				b: member.timeOffset,
			});
			snapPoint = memberStartSnap.snapPoint;
		}

		const memberEndSnap = resolveIndexedSnap({
			targetTime: addMediaTime({
				a: memberStartTime,
				b: member.duration,
			}),
			index,
			maxSnapDistance,
		});
		if (
			memberEndSnap.snapPoint &&
			memberEndSnap.snapDistance < closestSnapDistance
		) {
			closestSnapDistance = memberEndSnap.snapDistance;
			snappedAnchorStartTime = subMediaTime({
				a: subMediaTime({
					a: memberEndSnap.snappedTime,
					b: member.duration,
				}),
				b: member.timeOffset,
			});
			snapPoint = memberEndSnap.snapPoint;
		}
	}

	return {
		snappedAnchorStartTime,
		snapPoint,
	};
}
