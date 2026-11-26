import { getElementLocalTime, hasKeyframesForPath, upsertPathKeyframe } from "@/animation";
import { NUMBER_CHANNEL_LAYOUT, type ParamValues } from "@/params";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type { TimelineElement, VisualElement } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";

export function transformValues(transform: Transform) {
	return {
		"transform.positionX": transform.position.x,
		"transform.positionY": transform.position.y,
		"transform.scaleX": transform.scaleX,
		"transform.scaleY": transform.scaleY,
		"transform.rotate": transform.rotate,
	};
}

type TransformValues = ReturnType<typeof transformValues>;

export interface TransformGestureTarget {
	transform: Transform;
	values: TransformValues;
	animations: VisualElement["animations"];
	localTime: MediaTime;
	isWithinRange: boolean;
}

export function captureTransformGestureTarget({
	element,
	timelineTime,
}: {
	element: VisualElement;
	timelineTime: number;
}): TransformGestureTarget {
	const localTime = mediaTime({
		ticks: getElementLocalTime({
			timelineTime,
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});
	return {
		transform,
		values: transformValues(transform),
		animations: element.animations,
		localTime,
		isWithinRange: timelineTime >= element.startTime &&
			timelineTime <= element.startTime + element.duration,
	};
}

export function buildTransformGesturePatch({
	target,
	values,
}: {
	target: TransformGestureTarget;
	values: Partial<TransformValues>;
}): Partial<TimelineElement> {
	const params: ParamValues = {};
	let animations = target.animations;
	for (const propertyPath of Object.keys(values) as (keyof TransformValues)[]) {
		const value = values[propertyPath];
		// A shared-pivot rotation can leave tiny floating-point residues on an unchanged axis.
		if (value === undefined || !Number.isFinite(value) ||
			Math.abs(value - target.values[propertyPath]) < 1e-9) continue;
		if (target.isWithinRange && hasKeyframesForPath({ animations, propertyPath })) {
			animations = upsertPathKeyframe({
				animations,
				propertyPath,
				time: target.localTime,
				value,
				channelLayout: NUMBER_CHANNEL_LAYOUT,
				coerceValue: ({ value }) => value,
			});
		} else {
			params[propertyPath] = value;
		}
	}
	return { params, ...(animations !== target.animations && { animations }) };
}
