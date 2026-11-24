import { EditorCore } from "@/core";
import {
	updateScalarKeyframeCurve,
} from "@/animation";
import { isCompositeChannelData, isLeafChannelData } from "@/animation/channel-data";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateElementInSceneTracks } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type {
	AnimationPath,
	ChannelData,
	CurveHandle,
	ScalarAnimationKey,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import type { SceneTracks } from "@/timeline";

const E = 1e-9;

function nearPatchedChannel(
	before: ChannelData | undefined,
	after: ChannelData | undefined,
	componentKey: string,
): boolean {
	const pick = (data: ChannelData | undefined) => {
		if (!data) return undefined;
		if (isLeafChannelData(data)) return componentKey === "value" ? data : undefined;
		return isCompositeChannelData(data) ? data[componentKey] : undefined;
	};
	const left = pick(before);
	const right = pick(after);
	if (!left || !right) return left === right;
	const near = (a: number, b: number) => Math.abs(a - b) <= E;
	const nearHandle = (a?: CurveHandle, b?: CurveHandle) =>
		(!a && !b) || Boolean(a && b && a.dt === b.dt && near(a.dv, b.dv));
	if (left.keys.length !== right.keys.length) return false;
	return (left.keys as ScalarAnimationKey[]).every((key, index) => {
		const other = (right.keys as ScalarAnimationKey[])[index];
		return key.id === other.id && key.time === other.time && near(key.value, other.value)
			&& key.segmentToNext === other.segmentToNext && key.tangentMode === other.tangentMode
			&& nearHandle(key.leftHandle, other.leftHandle) && nearHandle(key.rightHandle, other.rightHandle);
	});
}

export class UpdateScalarKeyframeCurveCommand extends Command {
	override readonly recordsHumanFields = true;
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly propertyPath: AnimationPath;
	private readonly componentKey: string;
	private readonly keyframeId: string;
	private readonly patch: ScalarCurveKeyframePatch;

	constructor({
		trackId,
		elementId,
		propertyPath,
		componentKey,
		keyframeId,
		patch,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPath;
		componentKey: string;
		keyframeId: string;
		patch: ScalarCurveKeyframePatch;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.propertyPath = propertyPath;
		this.componentKey = componentKey;
		this.keyframeId = keyframeId;
		this.patch = patch;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let changed = false;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => {
				if (!resolveAnimationTarget({ element, path: this.propertyPath })) {
					return element;
				}

				const animations = updateScalarKeyframeCurve({
					animations: element.animations,
					propertyPath: this.propertyPath,
					componentKey: this.componentKey,
					keyframeId: this.keyframeId,
					patch: this.patch,
				});
				if (nearPatchedChannel(
					element.animations?.[this.propertyPath],
					animations?.[this.propertyPath],
					this.componentKey,
				)) {
					return element;
				}

				changed = true;
				return { ...element, animations };
			},
		});

		if (!changed) {
			return { changed: false };
		}

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
