import type { TimelineTrack, TimelineElement } from "@/timeline";
import type { ComputeDropTargetParams, DropTarget } from "@/timeline";
import { resolveTrackPlacement } from "@/timeline/placement";
import { TIMELINE_TRACK_GAP_PX } from "./layout";
import { getTrackHeight } from "./track-layout";
import {
	mediaTime,
	type MediaTime,
	roundFrameTime,
	roundMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";

function findElementAtPosition({
	mouseX,
	tracks,
	trackIndex,
	targetElementTypes,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	tracks: TimelineTrack[];
	trackIndex: number;
	targetElementTypes: string[];
	pixelsPerSecond: number;
	zoomLevel: number;
}): { elementId: string; trackId: string } | null {
	const time = mediaTime({
		ticks: Math.round(
			(mouseX / (pixelsPerSecond * zoomLevel)) * TICKS_PER_SECOND,
		),
	});
	const track = tracks[trackIndex];
	if (!track || !("elements" in track)) return null;

	const hit = track.elements.find(
		(element: TimelineElement) =>
			targetElementTypes.includes(element.type) &&
			element.startTime <= time &&
			time < element.startTime + element.duration,
	);
	if (!hit) return null;
	return { elementId: hit.id, trackId: track.id };
}

function getTrackAtY({
	mouseY,
	tracks,
	verticalDragDirection,
	external,
	getTrackExtraHeight,
}: {
	mouseY: number;
	tracks: TimelineTrack[];
	verticalDragDirection?: "up" | "down" | null;
	external: boolean;
	getTrackExtraHeight?: (trackIndex: number) => number;
}): { trackIndex: number; relativeY: number; inGap?: true } | null {
	let cumulativeHeight = 0;

	for (let i = 0; i < tracks.length; i++) {
		// A track with expanded keyframe lanes is taller on screen; the lanes belong to its row.
		const trackHeight = getTrackHeight({ type: tracks[i].type }) + (getTrackExtraHeight?.(i) ?? 0);
		const trackTop = cumulativeHeight;
		const trackBottom = trackTop + trackHeight;

		if (mouseY >= trackTop && mouseY < trackBottom) {
			return {
				trackIndex: i,
				relativeY: mouseY - trackTop,
			};
		}

		if (i < tracks.length - 1 && (verticalDragDirection || external)) {
			const gapTop = trackBottom;
			const gapBottom = gapTop + TIMELINE_TRACK_GAP_PX;
			if (mouseY >= gapTop && mouseY < gapBottom) {
				if (external) return { trackIndex: i + 1, relativeY: 0, inGap: true };
				const isDraggingUp = verticalDragDirection === "up";
				return {
					trackIndex: isDraggingUp ? i : i + 1,
					relativeY: isDraggingUp ? trackHeight - 1 : 0,
				};
			}
		}

		cumulativeHeight += trackHeight + TIMELINE_TRACK_GAP_PX;
	}

	return null;
}

const EMPTY_TARGET_ELEMENT = null;

function fallbackNewTrackDropTarget({
	xPosition,
}: {
	xPosition: MediaTime;
}): DropTarget {
	return {
		trackIndex: 0,
		isNewTrack: true,
		insertPosition: null,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function computeDropTarget({
	elementType,
	trackType,
	getTrackExtraHeight,
	mouseX,
	mouseY,
	tracks,
	isExternalDrop,
	elementDuration,
	pixelsPerSecond,
	zoomLevel,
	verticalDragDirection,
	startTimeOverride,
	frameRate,
	excludeElementId,
	excludeElementIds,
	targetElementTypes,
}: ComputeDropTargetParams): DropTarget {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	// Files dropped from outside land where the pointer is, like clips dragged inside the editor.
	const rawPosition =
		startTimeOverride !== undefined
			? startTimeOverride
			: mediaTime({
					ticks: Math.round(
						Math.max(0, mouseX / (pixelsPerSecond * zoomLevel)) *
							TICKS_PER_SECOND,
					),
				});
	const xPosition = frameRate ? roundFrameTime({ time: rawPosition, fps: frameRate }) : rawPosition;

	if (orderedTracks.length === 0) {
		const placementResult = resolveTrackPlacement({
			tracks,
			...(trackType ? { trackType } : { elementType }),
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: 0,
				hoverDirection: "below",
				createNewTrackOnly: true,
			},
		});
		const emptyTimelineResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!emptyTimelineResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: emptyTimelineResult.insertIndex,
			isNewTrack: true,
			insertPosition: emptyTimelineResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const trackAtMouse = getTrackAtY({
		mouseY,
		tracks: orderedTracks,
		verticalDragDirection,
		external: isExternalDrop,
		getTrackExtraHeight,
	});

	if (!trackAtMouse) {
		const isAboveAllTracks = mouseY < 0;

		const placementResult = resolveTrackPlacement({
			tracks,
			...(trackType ? { trackType } : { elementType }),
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: isAboveAllTracks ? 0 : orderedTracks.length - 1,
				hoverDirection: isAboveAllTracks ? "above" : "below",
				createNewTrackOnly: true,
			},
		});
		const outOfBoundsResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!outOfBoundsResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: outOfBoundsResult.insertIndex,
			isNewTrack: true,
			insertPosition: outOfBoundsResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const { trackIndex, relativeY, inGap } = trackAtMouse;
	const track = orderedTracks[trackIndex];

	if (!inGap && targetElementTypes && targetElementTypes.length > 0) {
		const targetElement = findElementAtPosition({
			mouseX,
			tracks: orderedTracks,
			trackIndex,
			targetElementTypes,
			pixelsPerSecond,
			zoomLevel,
		});
		if (targetElement) {
			return {
				trackIndex,
				isNewTrack: false,
				insertPosition: null,
				xPosition,
				targetElement,
			};
		}
	}

	const trackHeight = getTrackHeight({ type: track.type }) + (getTrackExtraHeight?.(trackIndex) ?? 0);
	const placementResult = resolveTrackPlacement({
		tracks,
		...(trackType ? { trackType } : { elementType }),
		timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId, excludeElementIds }],
		strategy: {
			type: "preferIndex",
			trackIndex,
			hoverDirection: relativeY < trackHeight / 2 ? "above" : "below",
			verticalDragDirection,
			createNewTrackOnly: inGap,
		},
	});
	if (!placementResult) {
		return fallbackNewTrackDropTarget({ xPosition });
	}

	if (placementResult.kind === "existingTrack") {
		const adjustedXPosition =
			placementResult.adjustedStartTime !== undefined
				? roundMediaTime({ time: placementResult.adjustedStartTime })
				: xPosition;

		return {
			trackIndex: placementResult.trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition: adjustedXPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	return {
		trackIndex: placementResult.insertIndex,
		isNewTrack: true,
		insertPosition: placementResult.insertPosition,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function getDropLineY({
	dropTarget,
	tracks,
	getTrackExtraHeight,
}: {
	dropTarget: DropTarget;
	tracks: TimelineTrack[];
	getTrackExtraHeight?: (trackIndex: number) => number;
}): number {
	const safeTrackIndex = Math.min(
		Math.max(dropTarget.trackIndex, 0),
		tracks.length,
	);
	let y = 0;

	for (let i = 0; i < safeTrackIndex; i++) {
		y += getTrackHeight({ type: tracks[i].type }) + (getTrackExtraHeight?.(i) ?? 0) + TIMELINE_TRACK_GAP_PX;
	}

	return y;
}
