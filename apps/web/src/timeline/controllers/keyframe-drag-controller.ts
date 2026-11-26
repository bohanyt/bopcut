import type { MouseEvent as ReactMouseEvent } from "react";
import type { PreviewGesture, TimelineManager } from "@/core/managers/timeline-manager";
import type { FrameRate } from "opencut-wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	addMediaTime,
	type MediaTime,
	mediaTime,
	roundFrameTime,
	snapSeekMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { getKeyframeById } from "@/animation";
import { RetimeKeyframesCommand } from "@/commands/timeline/element/keyframes/retime-keyframe";
import type { SelectedKeyframeRef } from "@/animation/types";
import type { TimelineElement } from "@/timeline";
import { beginTimelineGesture } from "@/timeline/gesture-state";
import { listenForTimelineMouseDrag } from "./mouse-drag";
import type { Command } from "@/commands/base-command";
import { finishFocusedField } from "@/utils/browser";

// --- Session ---

interface PendingSession {
	kind: "pending";
	keyframeRefs: SelectedKeyframeRef[];
	grabbedKeyframeRef: SelectedKeyframeRef;
	startMouseX: number;
}

interface ActiveSession {
	kind: "active";
	keyframeRefs: SelectedKeyframeRef[];
	startMouseX: number;
	anchorTimelineTime: MediaTime;
	deltaTicks: number;
	minDeltaTicks: number;
	maxDeltaTicks: number;
}

type Session = { kind: "idle" } | PendingSession | ActiveSession;

// --- Public state ---

export interface KeyframeDragState {
	isDragging: boolean;
	draggingKeyframeIds: Set<string>;
	deltaTicks: number;
}

const IDLE_DRAG_STATE: KeyframeDragState = {
	isDragging: false,
	draggingKeyframeIds: new Set(),
	deltaTicks: 0,
};

// --- Config ---

export interface KeyframeDragConfig {
	zoomLevel: number;
	getFps: () => FrameRate | null;
	element: TimelineElement;
	displayedStartTime: MediaTime;
	selectedKeyframes: SelectedKeyframeRef[];
	isKeyframeSelected: (args: { keyframe: SelectedKeyframeRef }) => boolean;
	setKeyframeSelection: (args: { keyframes: SelectedKeyframeRef[] }) => void;
	toggleKeyframeSelection: (args: {
		keyframes: SelectedKeyframeRef[];
		isMultiKey: boolean;
	}) => void;
	selectKeyframeRange: (args: {
		orderedKeyframes: SelectedKeyframeRef[];
		targetKeyframes: SelectedKeyframeRef[];
		isAdditive: boolean;
	}) => void;
	executeCommand: (command: Command) => void;
	beginPreviewGesture: TimelineManager["beginPreviewGesture"];
	seek: (args: { time: MediaTime }) => void;
	getTotalDuration: () => MediaTime;
}

export interface KeyframeDragConfigRef {
	readonly current: KeyframeDragConfig;
}

// --- Controller ---

export class KeyframeDragController {
	private session: Session = { kind: "idle" };
	// Persists through mouseup so the click handler can detect drag vs click
	private mouseDownX: number | null = null;
	private gestureOwner: PreviewGesture | null = null;
	private canceledMouseDown = false;
	private endGesture: (() => void) | null = null;
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: KeyframeDragConfigRef;

	constructor(deps: { configRef: KeyframeDragConfigRef }) {
		this.configRef = deps.configRef;
		this.onKeyframeMouseDown = this.onKeyframeMouseDown.bind(this);
		this.onKeyframeClick = this.onKeyframeClick.bind(this);
		this.getVisualOffsetPx = this.getVisualOffsetPx.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): KeyframeDragConfig {
		return this.configRef.current;
	}

	get keyframeDragState(): KeyframeDragState {
		if (this.session.kind !== "active") return IDLE_DRAG_STATE;
		return {
			isDragging: true,
			draggingKeyframeIds: new Set(
				this.session.keyframeRefs.map((kf) => kf.keyframeId),
			),
			deltaTicks: this.session.deltaTicks,
		};
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		this.subscribers.clear();
		this.gestureOwner?.cancel();
		this.endGesture?.();
	}

	onKeyframeMouseDown({
		event,
		keyframes,
	}: {
		event: ReactMouseEvent;
		keyframes: SelectedKeyframeRef[];
	}): void {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();

		finishFocusedField(event.currentTarget);
		this.gestureOwner = this.config.beginPreviewGesture(() => {
			this.canceledMouseDown = true;
			this.finishSession();
		});
		this.canceledMouseDown = false;
		this.mouseDownX = event.clientX;

		const anySelected = keyframes.some((kf) =>
			this.config.isKeyframeSelected({ keyframe: kf }),
		);
		const isModifierKey = event.shiftKey || event.metaKey || event.ctrlKey;

		if (!anySelected && !isModifierKey) {
			this.config.setKeyframeSelection({ keyframes });
		}

		this.session = {
			kind: "pending",
			keyframeRefs: (anySelected ? this.config.selectedKeyframes : keyframes)
				.filter((ref) => ref.elementId === this.config.element.id),
			grabbedKeyframeRef: keyframes[0],
			startMouseX: event.clientX,
		};
		this.activate();
		this.notify();
	}

	onKeyframeClick({
		event,
		keyframes,
		orderedKeyframes,
		indicatorTime,
	}: {
		event: ReactMouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}): void {
		event.stopPropagation();

		const wasDrag = this.canceledMouseDown ||
			(this.mouseDownX !== null &&
				Math.abs(event.clientX - this.mouseDownX) > TIMELINE_DRAG_THRESHOLD_PX);
		this.canceledMouseDown = false;
		this.mouseDownX = null;

		if (wasDrag) return;

		const { displayedStartTime, getFps, getTotalDuration, seek } = this.config;
		const fps = getFps();
		const absoluteIndicatorTime = addMediaTime({
			a: displayedStartTime,
			b: indicatorTime,
		});
		const seekTime =
			fps != null
				? snapSeekMediaTime({
						time: absoluteIndicatorTime,
						duration: getTotalDuration(),
						fps,
					})
				: absoluteIndicatorTime;
		seek({ time: seekTime });

		if (event.shiftKey) {
			this.config.selectKeyframeRange({
				orderedKeyframes,
				targetKeyframes: keyframes,
				isAdditive: event.metaKey || event.ctrlKey,
			});
			return;
		}

		this.config.toggleKeyframeSelection({
			keyframes,
			isMultiKey: event.metaKey || event.ctrlKey,
		});
	}

	getVisualOffsetPx({
		indicatorTime,
		indicatorOffsetPx,
		isBeingDragged,
		displayedStartTime,
		elementLeft,
	}: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}): number {
		if (!isBeingDragged || this.session.kind !== "active")
			return indicatorOffsetPx;
		const shiftedTime = addMediaTime({
			a: indicatorTime,
			b: mediaTime({ ticks: this.session.deltaTicks }),
		});
		return (
			timelineTimeToSnappedPixels({
				time: addMediaTime({ a: displayedStartTime, b: shiftedTime }),
				zoomLevel: this.config.zoomLevel,
			}) - elementLeft
		);
	}

	private activate(): void {
		this.stopListening = listenForTimelineMouseDrag({
			onMove: this.handleMouseMove,
			onRelease: this.handleMouseUp,
			onCancel: () => this.gestureOwner?.cancel(),
		});
	}

	private stopListening?: () => void;

	private deactivate(): void {
		this.stopListening?.();
		this.stopListening = undefined;
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private finishSession(): void {
		this.gestureOwner?.finish();
		this.gestureOwner = null;
		this.endGesture?.();
		this.endGesture = null;
		this.session = { kind: "idle" };
		this.deactivate();
		this.notify();
	}

	private commitDrag({
		keyframeRefs,
		deltaTicks,
	}: {
		keyframeRefs: SelectedKeyframeRef[];
		deltaTicks: number;
	}): void {
		const { element } = this.config;
		const keyframes = keyframeRefs.flatMap((ref) => {
			const keyframe = getKeyframeById({
				animations: element.animations,
				propertyPath: ref.propertyPath,
				keyframeId: ref.keyframeId,
			});
			if (!keyframe) return [];
			return [
				{
					propertyPath: ref.propertyPath,
					keyframeId: ref.keyframeId,
					nextTime: addMediaTime({
						a: keyframe.time,
						b: mediaTime({ ticks: deltaTicks }),
					}),
				},
			];
		});

		if (keyframes.length === 0) return;
		this.config.executeCommand(new RetimeKeyframesCommand({
			trackId: keyframeRefs[0].trackId,
			elementId: element.id,
			keyframes,
		}));
	}

	private handleMouseMove({ clientX }: MouseEvent): void {
		if (this.session.kind === "pending") {
			const deltaX = Math.abs(clientX - this.session.startMouseX);
			if (deltaX <= TIMELINE_DRAG_THRESHOLD_PX) return;

			const { element } = this.config;
			let earliest: number = element.duration;
			let latest = 0;
			for (const ref of this.session.keyframeRefs) {
				const keyframe = getKeyframeById({
					animations: element.animations,
					propertyPath: ref.propertyPath,
					keyframeId: ref.keyframeId,
				});
				if (!keyframe) continue;
				earliest = Math.min(earliest, keyframe.time);
				latest = Math.max(latest, keyframe.time);
			}

			const anchorRef = this.session.grabbedKeyframeRef;
			const anchorKeyframe = anchorRef
				? getKeyframeById({
						animations: element.animations,
						propertyPath: anchorRef.propertyPath,
						keyframeId: anchorRef.keyframeId,
					})
				: null;
			const anchorTimelineTime = anchorKeyframe
				? addMediaTime({ a: element.startTime, b: anchorKeyframe.time })
				: addMediaTime({ a: element.startTime, b: mediaTime({ ticks: earliest }) });

			this.session = {
				kind: "active",
				keyframeRefs: this.session.keyframeRefs,
				startMouseX: this.session.startMouseX,
				anchorTimelineTime,
				deltaTicks: 0,
				minDeltaTicks: -earliest,
				maxDeltaTicks: element.duration - latest,
			};
			this.endGesture ??= beginTimelineGesture();
			this.notify();
			return;
		}

		if (this.session.kind !== "active") return;

		const fps = this.config.getFps();
		if (!fps) return;

		const pixelsPerSecond =
			BASE_TIMELINE_PIXELS_PER_SECOND * this.config.zoomLevel;
		const rawDeltaTicks = Math.round(
			((clientX - this.session.startMouseX) / pixelsPerSecond) *
				TICKS_PER_SECOND,
		);
		const snappedAbsolute = roundFrameTime({
			time: addMediaTime({
				a: this.session.anchorTimelineTime,
				b: mediaTime({ ticks: rawDeltaTicks }),
			}),
			fps,
		});
		const snappedDelta = subMediaTime({
			a: snappedAbsolute,
			b: this.session.anchorTimelineTime,
		});
		this.session.deltaTicks = Math.max(
			this.session.minDeltaTicks,
			Math.min(this.session.maxDeltaTicks, snappedDelta),
		);
		this.notify();
	}

	private handleMouseUp(): void {
		if (this.session.kind === "pending") {
			this.finishSession();
			return;
		}

		if (this.session.kind !== "active") return;

		const { selectedKeyframes, element } = this.config;
		const { keyframeRefs, deltaTicks } = this.session;
		const draggingIds = new Set(keyframeRefs.map((r) => r.keyframeId));
		const draggingRefs = selectedKeyframes.filter(
			(kf) => kf.elementId === element.id && draggingIds.has(kf.keyframeId),
		);

		this.finishSession();
		if (draggingRefs.length > 0 && deltaTicks !== 0) {
			this.commitDrag({ keyframeRefs: draggingRefs, deltaTicks });
		}

	}
}
