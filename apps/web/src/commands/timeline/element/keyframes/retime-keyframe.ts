import { EditorCore } from "@/core";
import { retimeElementKeyframes } from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateElementInSceneTracks } from "@/timeline";
import type { AnimationPath } from "@/animation/types";
import type { SceneTracks } from "@/timeline";
import {
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { resolveAnimationTarget } from "@/timeline/animation-targets";

export class RetimeKeyframesCommand extends Command {
	override readonly recordsHumanFields = true;
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly keyframes: readonly {
		propertyPath: AnimationPath;
		keyframeId: string;
		nextTime: MediaTime;
	}[];

	constructor({
		trackId,
		elementId,
		keyframes,
	}: {
		trackId: string;
		elementId: string;
		keyframes: RetimeKeyframesCommand["keyframes"];
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.keyframes = keyframes;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => {
				const timesByPath = new Map<AnimationPath, Map<string, MediaTime>>();
				for (const { propertyPath, keyframeId, nextTime } of this.keyframes) {
					const timesByKeyframe = timesByPath.get(propertyPath) ?? new Map();
					timesByKeyframe.set(keyframeId, maxMediaTime({
						a: ZERO_MEDIA_TIME,
						b: minMediaTime({ a: nextTime, b: element.duration }),
					}));
					timesByPath.set(propertyPath, timesByKeyframe);
				}

				let animations = element.animations;
				for (const [propertyPath, timesByKeyframe] of timesByPath) {
					if (!resolveAnimationTarget({ element, path: propertyPath })) continue;
					animations = retimeElementKeyframes({ animations, propertyPath, timesByKeyframe });
				}
				return animations === element.animations ? element : { ...element, animations };
			},
		});

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
