import type { TimelineTrack } from "@/timeline";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { TICKS_PER_SECOND } from "@/wasm";
import { getTrackClipIndex } from "./track-clip-index";
import {
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
} from "./layout";
import { getTrackHeight } from "./track-layout";

type TimelineElementRef = { trackId: string; elementId: string };

interface SelectionRectangle {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function getNormalizedRectangle({
	startPos,
	endPos,
}: {
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	return {
		left: Math.min(startPos.x, endPos.x),
		top: Math.min(startPos.y, endPos.y),
		right: Math.max(startPos.x, endPos.x),
		bottom: Math.max(startPos.y, endPos.y),
	};
}

function getSelectionRectangleInContent({
	container,
	scrollContainer,
	startPos,
	endPos,
}: {
	container: HTMLElement;
	scrollContainer: HTMLDivElement | null;
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	const containerRect = container.getBoundingClientRect();
	const scrollRect = scrollContainer?.getBoundingClientRect() ?? containerRect;
	const scrollLeft = scrollContainer?.scrollLeft ?? 0;
	const scrollTop = scrollContainer?.scrollTop ?? 0;

	const adjustedStart = {
		x: startPos.x - scrollRect.left + scrollLeft,
		y: startPos.y - scrollRect.top + scrollTop,
	};
	const adjustedEnd = {
		x: endPos.x - scrollRect.left + scrollLeft,
		y: endPos.y - scrollRect.top + scrollTop,
	};

	return getNormalizedRectangle({
		startPos: adjustedStart,
		endPos: adjustedEnd,
	});
}

export function resolveTimelineElementIntersections({
	container,
	scrollContainer,
	tracks,
	zoomLevel,
	startPos,
	currentPos,
	getTrackExpansionHeight,
}: {
	container: HTMLElement;
	scrollContainer: HTMLDivElement | null;
	tracks: TimelineTrack[];
	zoomLevel: number;
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
	getTrackExpansionHeight?: (trackIndex: number) => number;
}): TimelineElementRef[] {
	const selectionRectangle = getSelectionRectangleInContent({
		container,
		scrollContainer,
		startPos,
		endPos: currentPos,
	});
	return hitTestTimelineElements({
		tracks,
		zoomLevel,
		selectionRectangle,
		getTrackExpansionHeight,
	});
}

export function hitTestTimelineElements({
	tracks,
	zoomLevel,
	selectionRectangle,
	getTrackExpansionHeight,
}: {
	tracks: TimelineTrack[];
	zoomLevel: number;
	selectionRectangle: SelectionRectangle;
	getTrackExpansionHeight?: (trackIndex: number) => number;
}): TimelineElementRef[] {
	const { left, right, top, bottom } = selectionRectangle;
	const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const start = (left / pixelsPerSecond) * TICKS_PER_SECOND;
	const end = (right / pixelsPerSecond) * TICKS_PER_SECOND;
	const selectedElements: TimelineElementRef[] = [];
	let elementTop = TIMELINE_CONTENT_TOP_PADDING_PX;

	for (const [trackIndex, track] of tracks.entries()) {
		if (elementTop > bottom) break;
		const elementBottom = elementTop + getTrackHeight({ type: track.type });
		if (elementBottom >= top) {
			for (const element of getTrackClipIndex(track.elements).query(
				start,
				end,
			)) {
				selectedElements.push({ trackId: track.id, elementId: element.id });
			}
		}
		elementTop =
			elementBottom +
			(getTrackExpansionHeight?.(trackIndex) ?? 0) +
			TIMELINE_TRACK_GAP_PX;
	}

	return selectedElements;
}
