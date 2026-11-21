import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { splitElementAt } from "@/timeline/split";
import type { MediaTime } from "@/wasm";

export class SplitElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private rightSideElements: ElementRef[] = [];
	private readonly splitIds = new Map<ElementRef, string>();
	private readonly elements: ElementRef[];
	private readonly splitTime: MediaTime;
	private readonly retainSide: "both" | "left" | "right";

	constructor({
		elements,
		splitTime,
		retainSide = "both",
	}: {
		elements: ElementRef[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}) {
		super();
		this.elements = elements;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
	}

	getRightSideElements(): ElementRef[] {
		return this.rightSideElements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const before = editor.scenes.getActiveScene().tracks;
		this.savedState = null;
		this.rightSideElements = [];
		let didSplit = false;

		const splitTrack = <
			TTrack extends { id: string; elements: TimelineElement[] },
		>(
			track: TTrack,
		): TTrack => {
			const elementsToSplit = this.elements.filter(
				(target) => target.trackId === track.id,
			);

			if (elementsToSplit.length === 0) {
				return track;
			}

			let changed = false;
			const elements = track.elements.flatMap((element) => {
				const target = elementsToSplit.find(
					(target) => target.elementId === element.id,
				);
				if (
					!target ||
					this.splitTime <= element.startTime ||
					this.splitTime >= element.startTime + element.duration
				) {
					return [element];
				}

				const rightId = this.splitIds.get(target) ?? generateUUID();
				this.splitIds.set(target, rightId);
				const parts = splitElementAt({
					element,
					splitTime: this.splitTime,
					rightId,
					boundaryIdPrefix: rightId,
				});
				if (!parts) return [element];
				changed = true;
				didSplit = true;

				// Single-sided trims keep the original clip's fades and presets.
				if (this.retainSide === "left") {
					return [{ ...parts.left, params: element.params }];
				}
				this.rightSideElements.push({ trackId: track.id, elementId: rightId });
				return this.retainSide === "right"
					? [{ ...parts.right, params: element.params }]
					: [parts.left, parts.right];
			});

			return changed ? { ...track, elements } : track;
		};

		const updatedTracks: SceneTracks = {
			overlay: before.overlay.map(splitTrack),
			main: splitTrack(before.main),
			audio: before.audio.map(splitTrack),
		};
		if (!didSplit) {
			return { changed: false };
		}

		this.savedState = before;
		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideElements.length > 0) {
			return createElementSelectionResult(this.rightSideElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
