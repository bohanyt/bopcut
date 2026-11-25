import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TScene, TimelineElement, TrackType } from "@/timeline";
import type { ElementClipboardItem } from "@/clipboard";
import { generateUUID } from "@/utils/id";
import {
	applyPlacement,
	resolveTrackPlacement,
	enforceMainTrackStart,
	type PlacementResult,
	type PlacementTimeSpan,
} from "@/timeline/placement";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import { cloneAnimations } from "@/animation";
import {
	collectCompoundScenes,
	deepCopyCompoundElements,
} from "@/timeline/compound";
import {
	applyCopiedScenes,
	removeCopiedScenes,
} from "@/commands/timeline/element/copied-scenes";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class PasteCommand extends Command {
	private savedState: SceneTracks | null = null;
	private pastedElements: { trackId: string; elementId: string }[] = [];
	private readonly time: MediaTime;
	private readonly clipboardItems: ElementClipboardItem[];
	private readonly scenes: TScene[];
	/** First result, replayed on redo so element, track, and nested scene ids stay the same. */
	private result: { tracks: SceneTracks; scenes: TScene[] } | null = null;

	constructor({
		time,
		clipboardItems,
		scenes = [],
	}: {
		time: MediaTime;
		clipboardItems: ElementClipboardItem[];
		/** Nested scenes of copied compound clips (each paste deep-copies them). */
		scenes?: TScene[];
	}) {
		super();
		this.time = time;
		this.clipboardItems = clipboardItems;
		this.scenes = scenes;
	}

	execute(): CommandResult | undefined {
		if (this.clipboardItems.length === 0) return undefined;

		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		if (this.result) {
			applyCopiedScenes({ ...this.result });
			return this.pastedElements.length > 0
				? createElementSelectionResult(this.pastedElements)
				: undefined;
		}
		this.pastedElements = [];

		const minStart = this.clipboardItems.reduce(
			(earliestStartTime, item) =>
				item.element.startTime < earliestStartTime
					? item.element.startTime
					: earliestStartTime,
			this.clipboardItems[0].element.startTime,
		);

		let updatedTracks = this.savedState;
		const itemsByTrackId = groupClipboardItemsByTrackId({
			clipboardItems: this.clipboardItems,
		});
		// Pasted compound clips get their own copy of their nested scenes (one copy pass, so
		// clips that shared a scene still share its copy).
		const deepCopy = deepCopyCompoundElements({
			elements: buildPastedElements({
				items: this.clipboardItems,
				minStart,
				time: this.time,
			}),
			// The copy-time snapshot wins over the current scenes.
			sourceScenes: [...editor.scenes.getScenes(), ...this.scenes],
		});
		const pastedByItem = new Map(
			this.clipboardItems.map((item, index) => [item, deepCopy.elements[index]]),
		);
		const placed: TimelineElement[] = [];
		const targetTrackIds = new Map<string, string>();
		// Layers are placed from the bottom up, each at or above the previous one, so the pasted
		// clips cover each other as their sources do.
		const groups = [...itemsByTrackId].sort(
			([, a], [, b]) => a[0].layer - b[0].layer,
		);
		let maxTrackIndex = Infinity;

		for (const [trackId, items] of groups) {
			const elementsToAdd = items.flatMap((item) => {
				const element = pastedByItem.get(item);
				return element ? [element] : [];
			});

			if (elementsToAdd.length === 0) {
				continue;
			}

			const trackType = items[0].trackType;
			const sourceTrackIndex = [
				...updatedTracks.overlay,
				updatedTracks.main,
				...updatedTracks.audio,
			].findIndex((track) => track.id === trackId);
			const placement = {
				tracks: updatedTracks,
				trackType,
				timeSpans: elementsToAdd.map((element) => ({
					startTime: element.startTime,
					duration: element.duration,
				})),
			};
			let placementResult =
				groups.length > 1
					? resolveLayerPlacement({
							...placement,
							layer: items[0].layer,
							sourceTrackIndex,
							maxTrackIndex: trackType === "audio" ? Infinity : maxTrackIndex,
						})
					: resolveTrackPlacement({
							...placement,
							strategy: { type: "aboveSource", sourceTrackIndex },
						});
			if (!placementResult) {
				continue;
			}

			let elementsForPlacement = elementsToAdd;
			if (placementResult.kind === "existingTrack") {
				const targetTrack =
					placementResult.trackIndex < updatedTracks.overlay.length
						? updatedTracks.overlay[placementResult.trackIndex]
						: placementResult.trackIndex === updatedTracks.overlay.length
							? updatedTracks.main
							: updatedTracks.audio[
									placementResult.trackIndex - updatedTracks.overlay.length - 1
								];
				if (targetTrack?.id === updatedTracks.main.id) {
					const earliestElement = elementsToAdd.reduce((earliest, element) =>
						element.startTime < earliest.startTime ? element : earliest,
					);
					const adjustedEarliestStartTime = enforceMainTrackStart({
						tracks: updatedTracks,
						targetTrackId: targetTrack.id,
						requestedStartTime: earliestElement.startTime,
					});
					const delta = subMediaTime({
						a: adjustedEarliestStartTime,
						b: earliestElement.startTime,
					});

					if (delta !== ZERO_MEDIA_TIME) {
						const shifted = elementsToAdd.map((element) => ({
							...element,
							startTime: maxMediaTime({
								a: ZERO_MEDIA_TIME,
								b: addMediaTime({ a: element.startTime, b: delta }),
							}),
						}));
						if (canPlaceTimeSpansOnTrack({ track: targetTrack, timeSpans: shifted })) {
							elementsForPlacement = shifted;
						} else {
							placementResult = resolveTrackPlacement({ tracks: updatedTracks, trackType,
								timeSpans: elementsToAdd, strategy: { type: "alwaysNew", position: "highest" },
							});
						}
					}
				}
			}

			if (!placementResult) continue;
			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				elements: elementsForPlacement,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;
			placed.push(...elementsForPlacement);

			if (trackType !== "audio") {
				maxTrackIndex = [...updatedTracks.overlay, updatedTracks.main].findIndex(
					(track) => track.id === applied.targetTrackId,
				);
			}
			for (const element of elementsForPlacement) {
				targetTrackIds.set(element.id, applied.targetTrackId);
			}
		}
		// The selection keeps the order of the copied clips.
		for (const element of deepCopy.elements) {
			const trackId = targetTrackIds.get(element.id);
			if (trackId) this.pastedElements.push({ trackId, elementId: element.id });
		}

		const copiedScenes = collectCompoundScenes({
			scenes: deepCopy.scenes,
			elements: placed,
		});
		this.result = { tracks: updatedTracks, scenes: copiedScenes };
		applyCopiedScenes({ ...this.result });

		if (this.pastedElements.length > 0) {
			return createElementSelectionResult(this.pastedElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			removeCopiedScenes({
				tracks: this.savedState,
				scenes: this.result?.scenes ?? [],
			});
		}
	}

	getPastedElements(): { trackId: string; elementId: string }[] {
		return this.pastedElements;
	}
}

/**
 * Place for one of several pasted layers: its own track if free, then the lowest free track that is
 * not below `maxTrackIndex`, then a new one on top. No track may move the clips in time.
 */
function resolveLayerPlacement({
	tracks,
	trackType,
	timeSpans,
	layer,
	sourceTrackIndex,
	maxTrackIndex,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
	timeSpans: PlacementTimeSpan[];
	layer: number;
	sourceTrackIndex: number;
	maxTrackIndex: number;
}): PlacementResult | null {
	const { overlay, main, audio } = tracks;
	const ordered = [...overlay, main, ...audio];
	const overlayFromBottom = [...overlay].reverse();
	const candidates = [
		ordered[sourceTrackIndex],
		ordered[sourceTrackIndex - 1],
		...(layer < 0
			? [...audio].reverse()
			: layer === 0
				? [main, ...overlayFromBottom]
				: [...overlayFromBottom, main]),
	];
	const start = timeSpans.reduce(
		(earliest, span) => (span.startTime < earliest ? span.startTime : earliest),
		timeSpans[0].startTime,
	);
	for (const track of candidates) {
		if (track?.type !== trackType) continue;
		const trackIndex = ordered.indexOf(track);
		if (
			trackIndex <= maxTrackIndex &&
			canPlaceTimeSpansOnTrack({ track, timeSpans }) &&
			enforceMainTrackStart({
				tracks,
				targetTrackId: track.id,
				requestedStartTime: start,
			}) === start
		) {
			return { kind: "existingTrack", trackId: track.id, trackIndex, trackType };
		}
	}
	return resolveTrackPlacement({
		tracks,
		trackType,
		timeSpans,
		strategy: { type: "alwaysNew", position: "highest" },
	});
}

function groupClipboardItemsByTrackId({
	clipboardItems,
}: {
	clipboardItems: ElementClipboardItem[];
}): Map<string, ElementClipboardItem[]> {
	const groupedItems = new Map<string, ElementClipboardItem[]>();

	for (const item of clipboardItems) {
		const existingItems = groupedItems.get(item.trackId) ?? [];
		groupedItems.set(item.trackId, [...existingItems, item]);
	}

	return groupedItems;
}

function buildPastedElements({
	items,
	minStart,
	time,
}: {
	items: ElementClipboardItem[];
	minStart: MediaTime;
	time: MediaTime;
}): TimelineElement[] {
	const elementsToAdd: TimelineElement[] = [];

	for (const item of items) {
		const relativeOffset = subMediaTime({
			a: item.element.startTime,
			b: minStart,
		});
		const startTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: addMediaTime({ a: time, b: relativeOffset }),
		});
		const newElementId = generateUUID();

		elementsToAdd.push({
			...item.element,
			id: newElementId,
			startTime,
			animations: cloneAnimations({
				animations: item.element.animations,
				shouldRegenerateKeyframeIds: true,
			}),
		} as TimelineElement);
	}

	return elementsToAdd;
}
