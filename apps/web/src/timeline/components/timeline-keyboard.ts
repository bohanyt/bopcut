import {
	useLayoutEffect,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
} from "react";
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

export function recoverTimelineFocus({
	before,
	tracks,
	from,
	hasControl,
}: {
	before: readonly TimelineTrack[];
	tracks: readonly TimelineTrack[];
	from: FocusLocation;
	hasControl: HasControl;
}): FocusLocation | undefined {
	const oldIndex = before.findIndex(({ id }) => id === from.trackId);
	const track = tracks.find(({ id }) => id === from.trackId);
	if (!track) {
		const fallback = tracks[Math.min(oldIndex, tracks.length - 1)];
		return fallback && { trackId: fallback.id };
	}
	const oldElements = before[oldIndex]?.elements ?? [];
	const position = oldElements.findIndex(({ id }) => id === from.elementId);
	const candidates = new Map(
		track.elements.map((element) => [element.id, element]),
	);
	const neighbors = [
		...oldElements.slice(position + 1),
		...oldElements.slice(0, Math.max(0, position)).reverse(),
	];
	for (const { id } of neighbors) {
		const element = candidates.get(id);
		if (element && hasControl(element))
			return { trackId: track.id, elementId: id };
	}
	return { trackId: track.id };
}

const ROW = "[data-timeline-track-id]";
const CLIP = "[data-timeline-element-id]";
const BUTTON = 'button:not([disabled]):not([tabindex="-1"])';

export function useTimelineKeyboard(
	tracks: readonly TimelineTrack[],
	getAssets: () => readonly MediaAsset[],
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const lastFocus = useRef<FocusLocation | null>(null);
	const previousTracks = useRef(tracks);
	const [pending, setPending] = useState<
		(FocusLocation & { direction: Direction }) | null
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

	const request = (
		root: HTMLElement,
		destination: FocusLocation,
		direction: Direction,
	) => {
		if (!focus(root, destination, direction))
			setPending({ ...destination, direction });
	};

	useLayoutEffect(() => {
		const root = rootRef.current;
		const before = previousTracks.current;
		previousTracks.current = tracks;
		if (!root) return;
		if (pending) {
			focus(root, pending, pending.direction);
			setPending(null);
			return;
		}
		const from = lastFocus.current;
		if (!from || before === tracks || document.activeElement !== document.body)
			return;
		const row = tracks.find(({ id }) => id === from.trackId);
		if (
			row &&
			(!from.elementId || row.elements.some(({ id }) => id === from.elementId))
		)
			return;
		lastFocus.current = null;
		const destination = recoverTimelineFocus({
			before,
			tracks,
			from,
			hasControl: controls(root),
		});
		if (destination) request(root, destination, 1);
	});

	return {
		pending,
		bindings: {
			ref: rootRef,
			onFocusCapture(event: FocusEvent<HTMLDivElement>) {
				const row = event.target.closest<HTMLElement>(ROW);
				const trackId = row?.dataset.timelineTrackId;
				if (trackId)
					lastFocus.current = {
						trackId,
						elementId:
							event.target.closest<HTMLElement>(CLIP)?.dataset
								.timelineElementId,
					};
			},
			onBlurCapture(event: FocusEvent<HTMLDivElement>) {
				if (
					event.relatedTarget &&
					!event.currentTarget.contains(event.relatedTarget)
				) {
					lastFocus.current = null;
				}
			},
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
				const from = lastFocus.current;
				if (
					!from ||
					!(target instanceof HTMLButtonElement) ||
					!target.matches(BUTTON)
				)
					return;
				const clip = target.closest(CLIP);
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
					from,
					direction,
					hasControl: controls(event.currentTarget),
				});
				if (!destination) return;
				event.preventDefault();
				request(event.currentTarget, destination, direction);
			},
		},
	};
}
