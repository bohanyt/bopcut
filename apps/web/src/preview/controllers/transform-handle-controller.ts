import type { PointerEvent as ReactPointerEvent } from "react";
import { finishFocusedField } from "@/utils/browser";
import type { PreviewGesture, TimelineManager } from "@/core/managers/timeline-manager";
import type { MediaAsset } from "@/media/types";
import type { PreviewPointerCapture } from "@/preview/pointer-capture";
import {
	getVisibleElementsWithBounds,
	getCornerPosition,
	type Corner,
	type Edge,
	type ElementBounds,
	type ElementWithBounds,
} from "@/preview/element-bounds";
import {
	MIN_SCALE,
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapRotation,
	snapScale,
	snapScaleAxes,
	type ScaleEdgePreference,
	type SnapLine,
} from "@/preview/preview-snap";
import { isVisualElement } from "@/timeline/element-utils";
import {
	buildTransformGesturePatch,
	captureTransformGestureTarget,
	transformValues,
	type TransformGestureTarget,
} from "@/preview/transform-gesture";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	VisualElement,
} from "@/timeline";

type Point = { readonly x: number; readonly y: number };
type CanvasSize = { readonly width: number; readonly height: number };
type HandleType = Corner | Edge | "rotation";

interface CapturedPointerState {
	readonly pointerId: number;
	readonly releasePointer: () => void;
}

interface CornerScaleSession extends CapturedPointerState {
	readonly kind: "corner-scale";
	readonly corner: Corner;
	readonly trackId: string;
	readonly elementId: string;
	readonly target: TransformGestureTarget;
	readonly initialDistance: number;
	readonly initialBoundsCx: number;
	readonly initialBoundsCy: number;
	readonly baseWidth: number;
	readonly baseHeight: number;
}

interface EdgeScaleSession extends CapturedPointerState {
	readonly kind: "edge-scale";
	readonly edge: Edge;
	readonly trackId: string;
	readonly elementId: string;
	readonly target: TransformGestureTarget;
	readonly initialBoundsCx: number;
	readonly initialBoundsCy: number;
	readonly baseWidth: number;
	readonly baseHeight: number;
	readonly rotationRad: number;
}

interface RotationSession extends CapturedPointerState {
	readonly kind: "rotation";
	readonly trackId: string;
	readonly elementId: string;
	readonly target: TransformGestureTarget;
	readonly initialAngle: number;
	readonly initialBoundsCx: number;
	readonly initialBoundsCy: number;
}

interface GroupSession extends CapturedPointerState {
	readonly kind: "group";
	readonly handle: HandleType;
	readonly cx: number;
	readonly cy: number;
	readonly start: Point;
	readonly members: Array<{
		trackId: string;
		elementId: string;
		target: TransformGestureTarget;
	}>;
}

type TransformSession =
	| GroupSession
	| { readonly kind: "idle" }
	| CornerScaleSession
	| EdgeScaleSession
	| RotationSession;

const IDLE_SESSION: TransformSession = { kind: "idle" };

interface VisualSelectionContext {
	readonly trackId: string;
	readonly elementId: string;
	readonly bounds: ElementBounds;
	readonly target: TransformGestureTarget;
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
	getSelectedElements: () => readonly ElementRef[];
	getTracks: () => SceneTracks;
	getCurrentTime: () => number;
	getMediaAssets: () => MediaAsset[];
	getCanvasSize: () => CanvasSize;
}

export interface TimelinePreviewUpdate {
	readonly trackId: string;
	readonly elementId: string;
	readonly updates: Partial<TimelineElement>;
}

export interface TimelineOps {
	previewElements: (updates: readonly TimelinePreviewUpdate[]) => void;
	commitPreview: () => void;
	beginPreviewGesture: TimelineManager["beginPreviewGesture"];
}

export interface PreviewOptions {
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}

export interface TransformHandleDeps {
	viewport: PreviewViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	timeline: TimelineOps;
	preview: PreviewOptions;
}

export interface TransformHandleDepsRef {
	readonly current: TransformHandleDeps;
}

function getPreferredEdge({ edge }: { edge: Edge }): ScaleEdgePreference {
	return edge === "right"
		? { right: true }
		: edge === "left"
			? { left: true }
			: { bottom: true };
}

function clampScaleNonZero(scale: number): number {
	if (Math.abs(scale) < MIN_SCALE) {
		return scale < 0 ? -MIN_SCALE : MIN_SCALE;
	}
	return scale;
}

function getCornerDistance({
	bounds,
	corner,
}: {
	bounds: ElementBounds;
	corner: Corner;
}): number {
	const halfWidth = bounds.width / 2;
	const halfHeight = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);

	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfWidth : halfWidth;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfHeight : halfHeight;

	const rotatedX = localX * cos - localY * sin;
	const rotatedY = localX * sin + localY * cos;
	return Math.sqrt(rotatedX * rotatedX + rotatedY * rotatedY) || 1;
}

function buildSelectedWithBounds({
	selectedElements,
	elementsWithBounds,
}: {
	selectedElements: readonly ElementRef[];
	elementsWithBounds: readonly ElementWithBounds[];
}): ElementWithBounds | null {
	if (selectedElements.length > 1) {
		const entries = elementsWithBounds.filter((entry) =>
			selectedElements.some(
				(ref) =>
					ref.trackId === entry.trackId && ref.elementId === entry.elementId,
			),
		);
		if (entries.length === 0) return null;
		const points = entries.flatMap(({ bounds }) =>
			(
				["top-left", "top-right", "bottom-left", "bottom-right"] as Corner[]
			).map((corner) => getCornerPosition({ bounds, corner })),
		);
		const left = Math.min(...points.map((p) => p.x)),
			right = Math.max(...points.map((p) => p.x));
		const top = Math.min(...points.map((p) => p.y)),
			bottom = Math.max(...points.map((p) => p.y));
		return {
			...entries[0],
			bounds: {
				cx: (left + right) / 2,
				cy: (top + bottom) / 2,
				width: right - left,
				height: bottom - top,
				rotation: 0,
			},
		};
	}
	if (selectedElements.length !== 1) return null;

	return (
		elementsWithBounds.find(
			(entry) =>
				entry.trackId === selectedElements[0].trackId &&
				entry.elementId === selectedElements[0].elementId,
		) ?? null
	);
}

export class TransformHandleController {
	private readonly depsRef: TransformHandleDepsRef;
	private readonly subscribers = new Set<() => void>();

	private session: TransformSession = IDLE_SESSION;
	private gestureOwner: PreviewGesture | null = null;

	constructor({ depsRef }: { depsRef: TransformHandleDepsRef }) {
		this.depsRef = depsRef;

		this.onCornerPointerDown = this.onCornerPointerDown.bind(this);
		this.onEdgePointerDown = this.onEdgePointerDown.bind(this);
		this.onRotationPointerDown = this.onRotationPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
	}

	private get deps(): TransformHandleDeps {
		return this.depsRef.current;
	}

	get selectedWithBounds(): ElementWithBounds | null {
		const selectedElements = this.deps.scene.getSelectedElements();
		if (selectedElements.length === 0) return null;
		return buildSelectedWithBounds({
			selectedElements,
			elementsWithBounds: this.getVisibleElementsWithBounds(selectedElements),
		});
	}

	get activeHandle(): HandleType | null {
		switch (this.session.kind) {
			case "group":
				return this.session.handle;
			case "corner-scale":
				return this.session.corner;
			case "edge-scale":
				return this.session.edge;
			case "rotation":
				return "rotation";
			default:
				return null;
		}
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		this.subscribers.clear();
		this.gestureOwner?.cancel();
	}

	private beginGesture(event: ReactPointerEvent): (() => void) | null {
		const releasePointer = this.deps.viewport.pointerCapture.tryCapture(
			event,
			() => this.gestureOwner?.cancel(),
		);
		if (!releasePointer) return null;
		this.gestureOwner = this.deps.timeline.beginPreviewGesture(() => {
			this.gestureOwner = null;
			this.endGesture();
			this.notify();
		});
		return releasePointer;
	}

	private endGesture(): void {
		if (this.session.kind === "idle") return;

		const session = this.session;
		this.session = IDLE_SESSION;
		this.clearSnapLines();
		session.releasePointer();
	}

	onCornerPointerDown({
		event,
		corner,
	}: {
		event: ReactPointerEvent;
		corner: Corner;
	}): void {
		if (event.button !== 0 || this.deps.viewport.pointerCapture.isActive) return;
		finishFocusedField(event.currentTarget);
		if (this.beginGroupGesture(event, corner)) return;
		const context = this.getSelectedVisualContext();
		if (!context) return;

		event.stopPropagation();

		const releasePointer = this.beginGesture(event);
		if (!releasePointer) return;
		this.session = {
			kind: "corner-scale",
			corner,
			trackId: context.trackId,
			elementId: context.elementId,
			target: context.target,
			initialDistance: getCornerDistance({
				bounds: context.bounds,
				corner,
			}),
			initialBoundsCx: context.bounds.cx,
			initialBoundsCy: context.bounds.cy,
			baseWidth: context.bounds.width / context.target.transform.scaleX,
			baseHeight: context.bounds.height / context.target.transform.scaleY,
			pointerId: event.pointerId,
			releasePointer,
		};

		this.notify();
	}

	onRotationPointerDown({ event }: { event: ReactPointerEvent }): void {
		if (event.button !== 0 || this.deps.viewport.pointerCapture.isActive) return;
		finishFocusedField(event.currentTarget);
		if (this.beginGroupGesture(event, "rotation")) return;
		const context = this.getSelectedVisualContext();
		if (!context) return;

		event.stopPropagation();

		const position = this.deps.viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!position) return;

		const deltaX = position.x - context.bounds.cx;
		const deltaY = position.y - context.bounds.cy;
		const initialAngle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;

		const releasePointer = this.beginGesture(event);
		if (!releasePointer) return;
		this.session = {
			kind: "rotation",
			trackId: context.trackId,
			elementId: context.elementId,
			target: context.target,
			initialAngle,
			initialBoundsCx: context.bounds.cx,
			initialBoundsCy: context.bounds.cy,
			pointerId: event.pointerId,
			releasePointer,
		};

		this.notify();
	}

	onEdgePointerDown({
		event,
		edge,
	}: {
		event: ReactPointerEvent;
		edge: Edge;
	}): void {
		if (event.button !== 0 || this.deps.viewport.pointerCapture.isActive) return;
		finishFocusedField(event.currentTarget);
		if (this.beginGroupGesture(event, edge)) return;
		const context = this.getSelectedVisualContext();
		if (!context) return;

		event.stopPropagation();

		const releasePointer = this.beginGesture(event);
		if (!releasePointer) return;
		this.session = {
			kind: "edge-scale",
			edge,
			trackId: context.trackId,
			elementId: context.elementId,
			target: context.target,
			initialBoundsCx: context.bounds.cx,
			initialBoundsCy: context.bounds.cy,
			baseWidth: context.bounds.width / context.target.transform.scaleX,
			baseHeight: context.bounds.height / context.target.transform.scaleY,
			rotationRad: (context.bounds.rotation * Math.PI) / 180,
			pointerId: event.pointerId,
			releasePointer,
		};

		this.notify();
	}

	onPointerMove({ event }: { event: ReactPointerEvent }): void {
		if (this.session.kind === "idle" || this.session.pointerId !== event.pointerId) return;

		const position = this.deps.viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!position) return;

		switch (this.session.kind) {
			case "group":
				this.previewGroup(this.session, position);
				return;
			case "corner-scale":
				this.previewCornerScale({
					session: this.session,
					position,
				});
				return;
			case "edge-scale":
				this.previewEdgeScale({
					session: this.session,
					position,
				});
				return;
			case "rotation":
				this.previewRotation({
					session: this.session,
					position,
				});
				return;
			default:
				return;
		}
	}

	onPointerUp(event: ReactPointerEvent): void {
		if (this.session.kind === "idle" || this.session.pointerId !== event.pointerId) return;
		if (event.type === "pointercancel" || event.type === "lostpointercapture") {
			this.gestureOwner?.cancel();
			return;
		}
		this.gestureOwner?.finish();
		this.gestureOwner = null;
		this.endGesture();
		this.deps.timeline.commitPreview();
		this.notify();
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private clearSnapLines(): void {
		this.deps.preview.onSnapLinesChange?.([]);
	}

	private getVisibleElementsWithBounds(onlyElements?: readonly ElementRef[]): ElementWithBounds[] {
		return getVisibleElementsWithBounds({
			tracks: this.deps.scene.getTracks(),
			currentTime: this.deps.scene.getCurrentTime(),
			canvasSize: this.deps.scene.getCanvasSize(),
			mediaAssets: this.deps.scene.getMediaAssets(),
			onlyElements,
		});
	}

	private beginGroupGesture(
		event: ReactPointerEvent,
		handle: HandleType,
	): boolean {
		const selected = this.deps.scene.getSelectedElements();
		if (selected.length < 2) return false;
		const group = this.selectedWithBounds;
		const start = this.deps.viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!group || !start) return true;
		const timelineTime = this.deps.scene.getCurrentTime();
		const tracks = this.deps.scene.getTracks();
		const entries = [...tracks.overlay, tracks.main, ...tracks.audio].flatMap(
			(track) =>
				"hidden" in track && track.hidden ? [] : track.elements
					.filter((element) =>
						selected.some(
							(ref) => ref.trackId === track.id && ref.elementId === element.id,
						),
					)
					.map((element) => ({
						trackId: track.id,
						elementId: element.id,
						element,
					})),
		);
		const members = entries
			.filter((entry) => isVisualElement(entry.element) && !entry.element.hidden)
			.map((entry) => {
				const element = entry.element as VisualElement;
				return {
					trackId: entry.trackId,
					elementId: entry.elementId,
					target: captureTransformGestureTarget({ element, timelineTime }),
				};
			});
		event.stopPropagation();
		const releasePointer = this.beginGesture(event);
		if (!releasePointer) return true;
		this.session = {
			kind: "group",
			handle,
			cx: group.bounds.cx,
			cy: group.bounds.cy,
			start,
			members,
			pointerId: event.pointerId,
			releasePointer,
		};
		this.notify();
		return true;
	}

	private previewGroup(session: GroupSession, position: Point): void {
		const { cx, cy, start, handle } = session;
		const dx = start.x - cx,
			dy = start.y - cy;
		const angle =
			handle === "rotation"
				? Math.atan2(position.y - cy, position.x - cx) - Math.atan2(dy, dx)
				: 0;
		const factor =
			handle === "rotation"
				? 1
				: Math.max(
						MIN_SCALE,
						Math.hypot(position.x - cx, position.y - cy) /
							(Math.hypot(dx, dy) || 1),
					);
		const canvas = this.deps.scene.getCanvasSize();
		const originX = cx - canvas.width / 2,
			originY = cy - canvas.height / 2;
		const cos = Math.cos(angle),
			sin = Math.sin(angle);
		this.deps.timeline.previewElements(
			session.members.map(({ trackId, elementId, target }) => {
				const { transform } = target;
				const x = transform.position.x - originX,
					y = transform.position.y - originY;
				return {
					trackId,
					elementId,
					updates: buildTransformGesturePatch({
						target,
						values: transformValues({
							position: {
								x: originX + factor * (x * cos - y * sin),
								y: originY + factor * (x * sin + y * cos),
							},
							scaleX: transform.scaleX * factor,
							scaleY: transform.scaleY * factor,
							rotate: transform.rotate + (angle * 180) / Math.PI,
						}),
					}),
				};
			}),
		);
	}

	private getSelectedVisualContext(): VisualSelectionContext | null {
		const selectedWithBounds = this.selectedWithBounds;
		if (!selectedWithBounds) return null;
		if (!isVisualElement(selectedWithBounds.element)) return null;

		return {
			trackId: selectedWithBounds.trackId,
			elementId: selectedWithBounds.elementId,
			bounds: selectedWithBounds.bounds,
			target: captureTransformGestureTarget({
				element: selectedWithBounds.element,
				timelineTime: this.deps.scene.getCurrentTime(),
			}),
		};
	}

	private previewCornerScale({
		session,
		position,
	}: {
		session: CornerScaleSession;
		position: Point;
	}): void {
		const deltaX = position.x - session.initialBoundsCx;
		const deltaY = position.y - session.initialBoundsCy;
		const currentDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
		const scaleFactor = currentDistance / session.initialDistance;

		// Use actual element dimensions (base * current scale) so snapping is
		// computed from the rendered geometry when scaleX != scaleY.
		const effectiveWidth = session.baseWidth * session.target.transform.scaleX;
		const effectiveHeight =
			session.baseHeight * session.target.transform.scaleY;

		const snapThreshold = this.deps.viewport.screenPixelsToLogicalThreshold({
			screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
		});
		const { snappedScale, activeLines } = this.deps.input.isShiftHeld()
			? { snappedScale: scaleFactor, activeLines: [] as SnapLine[] }
			: snapScale({
					proposedScale: scaleFactor,
					position: session.target.transform.position,
					baseWidth: effectiveWidth,
					baseHeight: effectiveHeight,
					rotation: session.target.transform.rotate,
					canvasSize: this.deps.scene.getCanvasSize(),
					snapThreshold,
				});

		this.deps.preview.onSnapLinesChange?.(activeLines);

		this.deps.timeline.previewElements([
			{
				trackId: session.trackId,
				elementId: session.elementId,
				updates: buildTransformGesturePatch({
					target: session.target,
					values: {
						"transform.scaleX": clampScaleNonZero(
							session.target.transform.scaleX * snappedScale,
						),
						"transform.scaleY": clampScaleNonZero(
							session.target.transform.scaleY * snappedScale,
						),
					},
				}),
			},
		]);
	}

	private previewEdgeScale({
		session,
		position,
	}: {
		session: EdgeScaleSession;
		position: Point;
	}): void {
		const deltaX = position.x - session.initialBoundsCx;
		const deltaY = position.y - session.initialBoundsCy;
		const xProjection =
			deltaX * Math.cos(session.rotationRad) +
			deltaY * Math.sin(session.rotationRad);
		const yProjection =
			-deltaX * Math.sin(session.rotationRad) +
			deltaY * Math.cos(session.rotationRad);
		const projection =
			session.edge === "right"
				? xProjection
				: session.edge === "left"
					? -xProjection
					: yProjection;

		const baseAxisHalf =
			session.edge === "right" || session.edge === "left"
				? session.baseWidth / 2
				: session.baseHeight / 2;
		const proposedScale = clampScaleNonZero(projection / baseAxisHalf);

		const proposedScaleX =
			session.edge === "right" || session.edge === "left"
				? proposedScale
				: session.target.transform.scaleX;
		const proposedScaleY =
			session.edge === "bottom"
				? proposedScale
				: session.target.transform.scaleY;

		const snapThreshold = this.deps.viewport.screenPixelsToLogicalThreshold({
			screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
		});
		const { x: xSnap, y: ySnap } = this.deps.input.isShiftHeld()
			? {
					x: {
						snappedScale: proposedScaleX,
						snapDistance: Infinity,
						activeLines: [] as SnapLine[],
					},
					y: {
						snappedScale: proposedScaleY,
						snapDistance: Infinity,
						activeLines: [] as SnapLine[],
					},
				}
			: snapScaleAxes({
					proposedScaleX,
					proposedScaleY,
					position: session.target.transform.position,
					baseWidth: session.baseWidth,
					baseHeight: session.baseHeight,
					rotation: session.target.transform.rotate,
					canvasSize: this.deps.scene.getCanvasSize(),
					snapThreshold,
					preferredEdges: getPreferredEdge({ edge: session.edge }),
				});

		const relevantSnap =
			session.edge === "right" || session.edge === "left" ? xSnap : ySnap;
		this.deps.preview.onSnapLinesChange?.(relevantSnap.activeLines);

		this.deps.timeline.previewElements([
			{
				trackId: session.trackId,
				elementId: session.elementId,
				updates: buildTransformGesturePatch({
					target: session.target,
					values: session.edge === "bottom"
						? { "transform.scaleY": ySnap.snappedScale }
						: { "transform.scaleX": xSnap.snappedScale },
				}),
			},
		]);
	}

	private previewRotation({
		session,
		position,
	}: {
		session: RotationSession;
		position: Point;
	}): void {
		const deltaX = position.x - session.initialBoundsCx;
		const deltaY = position.y - session.initialBoundsCy;
		const currentAngle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
		let deltaAngle = currentAngle - session.initialAngle;
		if (deltaAngle > 180) deltaAngle -= 360;
		if (deltaAngle < -180) deltaAngle += 360;

		const newRotate = session.target.transform.rotate + deltaAngle;
		const { snappedRotation } = this.deps.input.isShiftHeld()
			? { snappedRotation: newRotate }
			: snapRotation({ proposedRotation: newRotate });

		this.deps.timeline.previewElements([
			{
				trackId: session.trackId,
				elementId: session.elementId,
				updates: buildTransformGesturePatch({
					target: session.target,
					values: { "transform.rotate": snappedRotation },
				}),
			},
		]);
	}
}
