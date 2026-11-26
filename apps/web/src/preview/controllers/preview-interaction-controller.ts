import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import type { MediaAsset } from "@/media/types";
import { finishFocusedField } from "@/utils/browser";
import type { PreviewPointerCapture } from "@/preview/pointer-capture";
import type { PreviewGesture, TimelineManager } from "@/core/managers/timeline-manager";
import {
	getVisibleElementsWithBounds,
	type ElementWithBounds,
} from "@/preview/element-bounds";
import {
	getHitElements,
	hitTest,
	resolvePreferredHit,
} from "@/preview/hit-test";
import {
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapPosition,
	type SnapLine,
} from "@/preview/preview-snap";
import type { TCanvasSize } from "@/project/types";
import {
	buildTransformGesturePatch,
	captureTransformGestureTarget,
	type TransformGestureTarget,
} from "@/preview/transform-gesture";
import { isVisualElement } from "@/timeline/element-utils";
import type {
	ElementRef,
	SceneTracks,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VisualElement,
} from "@/timeline";

const MIN_DRAG_DISTANCE = 0.5;
const PRIMARY_POINTER_BUTTON = 0;

type Point = { readonly x: number; readonly y: number };

interface CapturedPointerState {
	readonly pointerId: number;
	readonly releasePointer: () => void;
}

interface PendingGesture extends CapturedPointerState {
	readonly kind: "pending";
	readonly origin: Point;
	readonly timelineTime: number;
	readonly topmostHit: ElementWithBounds | null;
	readonly selectedHit: ElementWithBounds | null;
	readonly selectedElements: readonly ElementRef[];
}

interface DragElementSnapshot {
	readonly trackId: string;
	readonly elementId: string;
	readonly target: TransformGestureTarget;
}

interface DraggingGesture extends CapturedPointerState {
	readonly kind: "dragging";
	readonly origin: Point;
	readonly bounds: {
		readonly width: number;
		readonly height: number;
		readonly rotation: number;
	};
	readonly elements: readonly DragElementSnapshot[];
}

type GestureSession =
	| { readonly kind: "idle" }
	| PendingGesture
	| DraggingGesture;

const IDLE_GESTURE: GestureSession = { kind: "idle" };

export interface EditingTextState {
	readonly trackId: string;
	readonly elementId: string;
	readonly element: TextElement;
}

export interface PreviewViewportAdapter {
	pointerCapture: PreviewPointerCapture;
	screenToCanvas: ({
		clientX,
		clientY,
	}: {
		clientX: number;
		clientY: number;
	}) => Point | null;
	screenPixelsToLogicalThreshold: ({
		screenPixels,
	}: {
		screenPixels: number;
	}) => Point;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SceneReader {
	getTracks: () => SceneTracks;
	getCurrentTime: () => number;
	getMediaAssets: () => MediaAsset[];
	getCanvasSize: () => TCanvasSize;
}

export interface SelectionApi {
	getSelected: () => readonly ElementRef[];
	setSelected: (elements: readonly ElementRef[]) => void;
	clearSelection: () => void;
}

export interface TimelinePreviewUpdate {
	readonly trackId: string;
	readonly elementId: string;
	readonly updates: Partial<TimelineElement>;
}

export interface TimelineOps {
	getElementsWithTracks: ({
		elements,
	}: {
		elements: readonly ElementRef[];
	}) => Array<{ track: TimelineTrack; element: TimelineElement }>;
	previewElements: (updates: readonly TimelinePreviewUpdate[], options?: { replace: boolean }) => void;
	commitPreview: () => void;
	beginPreviewGesture: TimelineManager["beginPreviewGesture"];
}

export interface PlaybackApi {
	getIsPlaying: () => boolean;
	subscribe: (listener: () => void) => () => void;
}

export interface PreviewOptions {
	isMaskMode: () => boolean;
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}

export interface PreviewInteractionDeps {
	viewport: PreviewViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	selection: SelectionApi;
	timeline: TimelineOps;
	playback: PlaybackApi;
	preview: PreviewOptions;
}

export interface PreviewInteractionDepsRef {
	readonly current: PreviewInteractionDeps;
}

function isSameElementRef({
	left,
	right,
}: {
	left: ElementRef;
	right: ElementRef;
}): boolean {
	return left.trackId === right.trackId && left.elementId === right.elementId;
}

function buildDragSelection({
	selectedElements,
	dragTarget,
}: {
	selectedElements: readonly ElementRef[];
	dragTarget: ElementWithBounds;
}): ElementRef[] {
	const dragTargetRef = {
		trackId: dragTarget.trackId,
		elementId: dragTarget.elementId,
	};

	if (
		!selectedElements.some((selectedElement) =>
			isSameElementRef({ left: selectedElement, right: dragTargetRef }),
		)
	) {
		return [dragTargetRef];
	}

	return [
		dragTargetRef,
		...selectedElements.filter(
			(selectedElement) =>
				!isSameElementRef({ left: selectedElement, right: dragTargetRef }),
		),
	];
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > MIN_DRAG_DISTANCE ||
		Math.abs(current.y - origin.y) > MIN_DRAG_DISTANCE
	);
}

function toDragElementSnapshots({
	elementsWithTracks,
	timelineTime,
}: {
	elementsWithTracks: Array<{ track: TimelineTrack; element: TimelineElement }>;
	timelineTime: number;
}): DragElementSnapshot[] {
	const isVisibleVisualElement = (value: {
		track: TimelineTrack;
		element: TimelineElement;
	}): value is { track: TimelineTrack; element: VisualElement } =>
		isVisualElement(value.element) && !value.element.hidden &&
		!("hidden" in value.track && value.track.hidden);

	return elementsWithTracks
		.filter(isVisibleVisualElement)
		.map(({ track, element }) => ({
			trackId: track.id,
			elementId: element.id,
			target: captureTransformGestureTarget({ element, timelineTime }),
		}));
}

export class PreviewInteractionController {
	private readonly depsRef: PreviewInteractionDepsRef;
	private readonly subscribers = new Set<() => void>();

	private gesture: GestureSession = IDLE_GESTURE;
	private gestureOwner: PreviewGesture | null = null;
	private editingTextState: EditingTextState | null = null;
	private memberId: string | null = null;
	private wasPlaying: boolean;
	private unsubscribePlayback: (() => void) | null = null;

	constructor({ depsRef }: { depsRef: PreviewInteractionDepsRef }) {
		this.depsRef = depsRef;
		this.wasPlaying = this.deps.playback.getIsPlaying();

		this.onDoubleClick = this.onDoubleClick.bind(this);
		this.onPointerDown = this.onPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
		this.commitTextEdit = this.commitTextEdit.bind(this);
		this.previewTextEdit = this.previewTextEdit.bind(this);
		this.handlePlaybackChange = this.handlePlaybackChange.bind(this);

		this.unsubscribePlayback = this.deps.playback.subscribe(
			this.handlePlaybackChange,
		);
	}

	private get deps(): PreviewInteractionDeps {
		return this.depsRef.current;
	}

	get editingText(): EditingTextState | null {
		return this.editingTextState;
	}

	subscribe({ listener }: { listener: () => void }): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	destroy(): void {
		this.unsubscribePlayback?.();
		this.unsubscribePlayback = null;
		this.subscribers.clear();
		this.cancel();
	}

	cancel(): void {
		this.memberId = null;
		this.gestureOwner?.cancel();
	}

	private startGesture(): void {
		this.gestureOwner = this.deps.timeline.beginPreviewGesture(() => {
			this.gestureOwner = null;
			this.editingTextState = null;
			this.endPointerGesture();
			this.notify();
		});
	}

	private endPointerGesture(): void {
		const gesture = this.gesture;
		this.gesture = IDLE_GESTURE;
		if (gesture.kind === "idle") return;
		this.clearSnapLines();
		gesture.releasePointer();
	}

	private finishGesture(): void {
		this.gestureOwner?.finish();
		this.gestureOwner = null;
		this.endPointerGesture();
	}

	previewTextEdit(content: string): void {
		if (!this.editingTextState) return;
		const { trackId, elementId } = this.editingTextState;
		this.deps.timeline.previewElements([
			{ trackId, elementId, updates: { params: { content } } },
		]);
	}

	commitTextEdit(): void {
		if (!this.editingTextState) return;

		this.editingTextState = null;
		this.finishGesture();
		this.deps.timeline.commitPreview();
		this.notify();
	}

	onDoubleClick({ clientX, clientY }: ReactMouseEvent): void {
		if (
			this.gestureOwner ||
			this.deps.viewport.pointerCapture.isActive ||
			this.deps.preview.isMaskMode()
		) return;

		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hit = hitTest({
			canvasX: startPos.x,
			canvasY: startPos.y,
			elementsWithBounds: this.getVisibleElementsWithBounds(),
		});

		if (!hit) return;
		if (hit.element.groupId && this.memberId !== hit.elementId) {
			this.memberId = hit.elementId;
			this.deps.selection.setSelected([
				{ trackId: hit.trackId, elementId: hit.elementId },
			]);
			return;
		}
		if (hit.element.type !== "text") return;

		this.startGesture();
		this.editingTextState = {
			trackId: hit.trackId,
			elementId: hit.elementId,
			element: hit.element,
		};
		this.notify();
	}

	onPointerDown({
		clientX,
		clientY,
		currentTarget,
		pointerId,
		button,
	}: ReactPointerEvent): void {
		if (this.gestureOwner) return;
		if (this.deps.viewport.pointerCapture.isActive) return;
		if (this.deps.preview.isMaskMode()) return;
		if (button !== PRIMARY_POINTER_BUTTON) return;

		finishFocusedField(currentTarget);
		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hits = getHitElements({
			canvasX: startPos.x,
			canvasY: startPos.y,
			elementsWithBounds: this.getVisibleElementsWithBounds(),
		});
		const selectedElements = this.deps.selection.getSelected();

		const releasePointer = this.deps.viewport.pointerCapture.tryCapture(
			{ currentTarget, pointerId },
			() => this.cancel(),
		);
		if (!releasePointer) return;
		this.startGesture();
		this.gesture = {
			kind: "pending",
			origin: startPos,
			timelineTime: this.deps.scene.getCurrentTime(),
			pointerId,
			releasePointer,
			topmostHit: hits[0] ?? null,
			selectedHit: resolvePreferredHit({
				hits,
				preferredElements: [...selectedElements],
			}),
			selectedElements,
		};
	}

	onPointerMove({ clientX, clientY, pointerId }: ReactPointerEvent): void {
		if (this.gesture.kind === "idle" || this.gesture.pointerId !== pointerId) return;
		const currentPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!currentPos) return;

		if (this.gesture.kind === "pending") {
			const pending = this.gesture;
			if (
				!movedPastDragThreshold({
					current: currentPos,
					origin: pending.origin,
				})
			) {
				this.clearSnapLines();
				return;
			}

			this.beginDragFromPending({ pending });
		}

		if (this.gesture.kind !== "dragging") return;

		this.updateDragPreview({
			drag: this.gesture,
			currentPos,
		});
	}

	onPointerUp({ type, pointerId }: ReactPointerEvent): void {
		if (this.gesture.kind === "idle" || this.gesture.pointerId !== pointerId) return;
		if (type === "pointercancel" || type === "lostpointercapture") {
			this.cancel();
			return;
		}
		if (this.gesture.kind === "dragging") {
			this.finishGesture();
			this.deps.timeline.commitPreview();
			this.notify();
			return;
		}

		const clickTarget = this.gesture.topmostHit;
		this.finishGesture();
		if (!clickTarget) {
			this.memberId = null;
			this.deps.selection.clearSelection();
		} else {
			if (this.memberId !== clickTarget.elementId) this.memberId = null;
			this.deps.selection.setSelected(this.groupSelection(clickTarget));
		}
	}

	private groupSelection(hit: ElementWithBounds): ElementRef[] {
		const groupId = hit.element.groupId;
		if (!groupId || this.memberId === hit.elementId)
			return [{ trackId: hit.trackId, elementId: hit.elementId }];
		const tracks = this.deps.scene.getTracks();
		return [...tracks.overlay, tracks.main, ...tracks.audio].flatMap((track) =>
			track.elements
				.filter((element) => element.groupId === groupId)
				.map((element) => ({ trackId: track.id, elementId: element.id })),
		);
	}

	private notify(): void {
		for (const listener of this.subscribers) listener();
	}

	private clearSnapLines(): void {
		this.deps.preview.onSnapLinesChange?.([]);
	}

	private getVisibleElementsWithBounds(): ElementWithBounds[] {
		return getVisibleElementsWithBounds({
			tracks: this.deps.scene.getTracks(),
			currentTime: this.deps.scene.getCurrentTime(),
			canvasSize: this.deps.scene.getCanvasSize(),
			mediaAssets: this.deps.scene.getMediaAssets(),
		});
	}

	private handlePlaybackChange(): void {
		const isPlaying = this.deps.playback.getIsPlaying();
		if (isPlaying && !this.wasPlaying && this.editingTextState) {
			this.commitTextEdit();
		}
		this.wasPlaying = isPlaying;
	}

	private beginDragFromPending({ pending }: { pending: PendingGesture }): void {
		const dragTarget = pending.selectedHit ?? pending.topmostHit;
		if (!dragTarget) {
			this.finishGesture();
			return;
		}

		const dragSelection = pending.selectedHit
			? buildDragSelection({
					selectedElements: pending.selectedElements,
					dragTarget,
				})
			: this.groupSelection(dragTarget);
		const draggableElements = toDragElementSnapshots({
			timelineTime: pending.timelineTime,
			elementsWithTracks: this.deps.timeline.getElementsWithTracks({
				elements: dragSelection,
			}),
		});

		if (draggableElements.length === 0) {
			this.finishGesture();
			return;
		}

		if (pending.selectedHit === null) {
			this.deps.selection.setSelected(dragSelection);
		}

		this.gesture = {
			kind: "dragging",
			origin: pending.origin,
			pointerId: pending.pointerId,
			releasePointer: pending.releasePointer,
			bounds: {
				width: dragTarget.bounds.width,
				height: dragTarget.bounds.height,
				rotation: dragTarget.bounds.rotation,
			},
			elements: draggableElements,
		};
		this.notify();
	}

	private updateDragPreview({
		drag,
		currentPos,
	}: {
		drag: DraggingGesture;
		currentPos: Point;
	}): void {
		const firstElement = drag.elements[0];
		if (!firstElement) return;
		const { position } = firstElement.target.transform;

		const deltaX = currentPos.x - drag.origin.x;
		const deltaY = currentPos.y - drag.origin.y;

		const proposedPosition = {
			x: position.x + deltaX,
			y: position.y + deltaY,
		};

		const shouldSnap = !this.deps.input.isShiftHeld();
		const snapThreshold = this.deps.viewport.screenPixelsToLogicalThreshold({
			screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
		});
		const { snappedPosition, activeLines } = shouldSnap
			? snapPosition({
					proposedPosition,
					canvasSize: this.deps.scene.getCanvasSize(),
					elementSize: drag.bounds,
					rotation: drag.bounds.rotation,
					snapThreshold,
				})
			: {
					snappedPosition: proposedPosition,
					activeLines: [] as SnapLine[],
				};

		this.deps.preview.onSnapLinesChange?.(activeLines);

		const deltaSnappedX = snappedPosition.x - position.x;
		const deltaSnappedY = snappedPosition.y - position.y;

		this.deps.timeline.previewElements(
			drag.elements.map(({ trackId, elementId, target }) => ({
				trackId,
				elementId,
				updates: buildTransformGesturePatch({
					target,
					values: {
						"transform.positionX": target.transform.position.x + deltaSnappedX,
						"transform.positionY": target.transform.position.y + deltaSnappedY,
					},
				}),
			})),
			{ replace: true },
		);
	}
}
