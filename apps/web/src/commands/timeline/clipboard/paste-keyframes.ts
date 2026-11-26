import { EditorCore } from "@/core";
import {
	getKeyframeAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import type { KeyframeClipboardItem } from "@/clipboard";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type PasteKeyframeItem = KeyframeClipboardItem & { keyframeId: string };

function pasteKeyframesIntoElement({
	element,
	time,
	clipboardItems,
}: {
	element: TimelineElement;
	time: MediaTime;
	clipboardItems: PasteKeyframeItem[];
}): TimelineElement {
	let nextElement = element;
	const pasted: { item: PasteKeyframeItem; keyframeId: string }[] = [];
	// Keyframe times count from the start of the clip.
	const localTime = subMediaTime({ a: time, b: element.startTime });

	for (const item of clipboardItems) {
		const target = resolveAnimationTarget({
			element: nextElement,
			path: item.propertyPath,
		});
		if (!target) {
			continue;
		}

		const keyframeTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: minMediaTime({
				a: addMediaTime({ a: localTime, b: item.timeOffset }),
				b: nextElement.duration,
			}),
		});
		const nextAnimations = upsertPathKeyframe({
			animations: nextElement.animations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
			value: item.value,
			interpolation: item.interpolation,
			keyframeId: item.keyframeId,
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
		if (nextAnimations === nextElement.animations) continue;
		const pastedKeyframe = getKeyframeAtTime({
			animations: nextAnimations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
		});
		if (pastedKeyframe) pasted.push({ item, keyframeId: pastedKeyframe.id });

		nextElement = {
			...nextElement,
			animations: nextAnimations,
		};
	}

	// The curves go on once every pasted keyframe is in place: a keyframe's outgoing handle is
	// dropped while the keyframe after it is not there yet.
	let patchedAnimations = nextElement.animations;
	for (const { item, keyframeId } of pasted) {
		for (const curvePatch of item.curvePatches) {
			patchedAnimations = updateScalarKeyframeCurve({
				animations: patchedAnimations,
				propertyPath: item.propertyPath,
				componentKey: curvePatch.componentKey,
				keyframeId,
				patch: curvePatch.patch,
			}) ?? patchedAnimations;
		}
	}

	return patchedAnimations === nextElement.animations
		? nextElement
		: { ...nextElement, animations: patchedAnimations };
}

export class PasteKeyframesCommand extends Command {
	override readonly recordsHumanFields = true;
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly time: MediaTime;
	private readonly clipboardItems: PasteKeyframeItem[];

	constructor({
		trackId,
		elementId,
		time,
		clipboardItems,
	}: {
		trackId: string;
		elementId: string;
		time: MediaTime;
		clipboardItems: KeyframeClipboardItem[];
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.time = time;
		this.clipboardItems = clipboardItems.map((item) => ({ ...item, keyframeId: generateUUID() }));
	}

	execute(): CommandResult | undefined {
		if (this.clipboardItems.length === 0) {
			return { changed: false };
		}

		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let changed = false;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => {
				const updated = pasteKeyframesIntoElement({
					element,
					time: this.time,
					clipboardItems: this.clipboardItems,
				});
				changed ||= updated !== element;
				return updated;
			},
		});

		if (!changed) return { changed: false };
		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
