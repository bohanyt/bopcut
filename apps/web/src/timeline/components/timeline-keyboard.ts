import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
	hasElementEffects,
	type TimelineElement,
	type TimelineTrack,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { getClipThumbnailUrl } from "./timeline-element";

type FocusLocation = { trackId: string; elementId?: string };
type HasControl = (element: TimelineElement) => boolean;
type Direction = 1 | -1;

export function findTimelineFocusTarget({
	tracks,
	from,
	direction,
	hasControl,
}: {
	tracks: readonly TimelineTrack[];
	from: FocusLocation;
	direction: Direction;
	hasControl: HasControl;
}): FocusLocation | undefined {
	const i = tracks.findIndex(({ id }) => id === from.trackId);
	const track = tracks[i];
	if (!track) return;
	const clipIndex = from.elementId
		? track.elements.findIndex(({ id }) => id === from.elementId)
		: -1;

	if (direction === -1 && !from.elementId) {
		const previous = tracks[i - 1];
		if (!previous) return;
		const last = previous.elements.findLast(hasControl);
		return last
			? { trackId: previous.id, elementId: last.id }
			: { trackId: previous.id };
	}

	for (
		let j = clipIndex + direction;
		j >= 0 && j < track.elements.length;
		j += direction
	) {
		const element = track.elements[j];
		if (hasControl(element))
			return { trackId: track.id, elementId: element.id };
	}
	const destination = direction === -1 ? track : tracks[i + 1];
	return destination && { trackId: destination.id };
}

const ROW = "[data-timeline-track-id]";
const CLIP = "[data-timeline-element-id]";
const BUTTON = 'button:not([disabled]):not([tabindex="-1"])';

export function useTimelineKeyboard(
	tracks: readonly TimelineTrack[],
	getAssets: () => readonly MediaAsset[],
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [pending, setPending] = useState<
		(FocusLocation & { direction: Direction; origin: HTMLButtonElement }) | null
	>(null);

	const controls = (root: HTMLElement) => {
		const mounted = new Map(
			Array.from(
				root.querySelectorAll<HTMLElement>(CLIP),
				(node) => [node.dataset.timelineElementId, node] as const,
			),
		);
		const assets = getAssets();
		return (element: TimelineElement) => {
			const node = mounted.get(element.id);
			if (node) return !!node.querySelector(BUTTON);
			return (
				(element.type === "video" || element.type === "image") &&
				hasElementEffects({ element }) &&
				!!getClipThumbnailUrl(
					element,
					assets.find(({ id }) => id === element.mediaId),
				)
			);
		};
	};

	const focus = (
		root: HTMLElement,
		destination: FocusLocation,
		direction: Direction,
	) => {
		const row = root.querySelector<HTMLElement>(
			`[data-timeline-track-id="${CSS.escape(destination.trackId)}"]`,
		);
		const clip =
			destination.elementId &&
			row?.querySelector<HTMLElement>(
				`[data-timeline-element-id="${CSS.escape(destination.elementId)}"]`,
			);
		const buttons = clip
			? clip.querySelectorAll<HTMLButtonElement>(BUTTON)
			: undefined;
		const button = destination.elementId
			? buttons?.[direction === 1 ? 0 : buttons.length - 1]
			: row?.querySelector<HTMLButtonElement>("[data-timeline-track-button]");
		if (!button) return false;
		button.scrollIntoView({ block: "nearest", inline: "nearest" });
		button.focus({ preventScroll: true });
		return true;
	};

	// A pending target exists only when a Tab press needs to mount a clip first.
	useLayoutEffect(() => {
		if (!pending) return;
		const root = rootRef.current;
		if (root && root.ownerDocument.activeElement === pending.origin) {
			focus(root, pending, pending.direction);
		}
		setPending(null);
	}, [pending]);

	return {
		pending,
		bindings: {
			ref: rootRef,
			onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
				if (
					event.key !== "Tab" ||
					event.defaultPrevented ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey
				)
					return;
				const target = event.target;
				const root = event.currentTarget;
				if (
					!(target instanceof HTMLButtonElement) ||
					target !== root.ownerDocument.activeElement ||
					!root.contains(target) ||
					!target.matches(BUTTON)
				)
					return;
				const trackId =
					target.closest<HTMLElement>(ROW)?.dataset.timelineTrackId;
				if (!trackId) return;
				const clip = target.closest<HTMLElement>(CLIP);
				const direction = event.shiftKey ? -1 : 1;
				const buttons = clip?.querySelectorAll(BUTTON);
				if (
					buttons &&
					target !== buttons[direction === 1 ? buttons.length - 1 : 0]
				)
					return;
				if (!clip && !target.hasAttribute("data-timeline-track-button")) return;
				const destination = findTimelineFocusTarget({
					tracks,
					from: { trackId, elementId: clip?.dataset.timelineElementId },
					direction,
					hasControl: controls(root),
				});
				if (!destination) return;
				event.preventDefault();
				if (!focus(root, destination, direction)) {
					setPending({ ...destination, direction, origin: target });
				}
			},
		},
	};
}
