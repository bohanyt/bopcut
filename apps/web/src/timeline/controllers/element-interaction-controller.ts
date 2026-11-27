import type { MouseEvent as ReactMouseEvent } from "react";
import type { PreviewGesture, TimelineManager } from "@/core/managers/timeline-manager";
import {
	buildGroupSnapIndex,
	buildMoveGroup,
	resolveGroupMove,
	snapGroupEdges,
	type GroupMoveResult,
	type MoveGroup,
} from "@/timeline/group-move";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	maxMediaTime,
	type MediaTime,
	mediaTime,
	roundFrameTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import type { FrameRate } from "opencut-wasm";
import { computeDropTarget } from "@/timeline/components/drop-target";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import { generateUUID } from "@/utils/id";
import { finishFocusedField } from "@/utils/browser";
import { beginTimelineGesture } from "@/timeline/gesture-state";
import { listenForTimelineMouseDrag } from "./mouse-drag";
import type { SnapIndex, SnapPoint } from "@/timeline/snapping";
import type {
	DropTarget,
	ElementRef,
	ElementDragView,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";

const MOUSE_BUTTON_RIGHT = 2;

// --- Config ---

export interface ViewportAdapter {
	getZoomLevel: () => number;
	getTracksScrollEl: () => HTMLDivElement | null;
	getTracksContainerEl: () => HTMLDivElement | null;
	getHeaderEl: () => HTMLElement | null;
	/** Height of a track's expanded keyframe lanes (ordered track index). */
	getTrackExtraHeight?: (trackIndex: number) => number;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SceneReader {
	getTracks: () => SceneTracks;
	getActiveFps: () => FrameRate | null;
}

export interface ElementSelectionApi {
	getSelected: () => readonly ElementRef[];
	isSelected: (ref: ElementRef) => boolean;
	select: (ref: ElementRef) => void;
	handleClick: (args: ElementRef & { isMultiKey: boolean }) => void;
	clearKeyframeSelection: () => void;
}

export interface PlaybackReader {
	getCurrentTime: () => MediaTime;
}

export interface TimelineOps {
	moveElements: (args: Pick<GroupMoveResult, "moves" | "createTracks">) => void;
	beginPreviewGesture: TimelineManager["beginPreviewGesture"];
}

export interface SnapConfig {
	isEnabled: () => boolean;
	onChange?: (snapPoint: SnapPoint | null) => void;
}

export interface ElementInteractionDeps {
	viewport: ViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	selection: ElementSelectionApi;
	playback: PlaybackReader;
	timeline: TimelineOps;
	snap: SnapConfig;
}

export interface ElementInteractionDepsRef {
	readonly current: ElementInteractionDeps;
}

// --- Session ---

type Point = { readonly x: number; readonly y: number };

interface MousedownSnapshot {
	readonly origin: Point;
	readonly scrollLeft: number;
	readonly scrollTop: number;
	readonly zoomLevel: number;
	readonly elementId: string;
	readonly trackId: string;
	readonly startElementTime: MediaTime;
	readonly clickOffsetTime: MediaTime;
	readonly selectedElements: readonly ElementRef[];
}

interface DragProgress {
	moveGroup: MoveGroup;
	movingElementIds?: ReadonlySet<string>;
	// Pre-minted per member so the identity of any "new track" created by
	// this drag stays stable across mousemove-driven drop-target recomputes.
	// `resolveGroupMoveForDrop` runs every mousemove and emits a
	// `createTracks[]` carrying these IDs; downstream consumers (snap
	// indicator, drop-line, commit path) see the same entity every frame
	// instead of a churning UUID.
	reservedNewTrackIds: readonly string[];
	currentTime: MediaTime;
	currentMouseX: number;
	currentMouseY: number;
	groupMoveResult: GroupMoveResult | null;
	dropTarget: DropTarget | null;
}

type Session =
	| { kind: "idle" }
	| { kind: "pending"; mousedown: MousedownSnapshot }
	| { kind: "dragging"; mousedown: MousedownSnapshot; drag: DragProgress };

const IDLE_VIEW: ElementDragView = { kind: "idle" };

function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.trackIndex === b.trackIndex && a.isNewTrack === b.isNewTrack && a.insertPosition === b.insertPosition &&
		a.xPosition === b.xPosition && a.targetElement?.elementId === b.targetElement?.elementId &&
		a.targetElement?.trackId === b.targetElement?.trackId;
}

// --- Pure helpers ---

function pixelToClickOffsetTime({
	clientX,
	elementRect,
	zoomLevel,
}: {
	clientX: number;
	elementRect: DOMRect;
	zoomLevel: number;
}): MediaTime {
	const clickOffsetX = clientX - elementRect.left;
	const seconds = clickOffsetX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function verticalDirection({
	startMouseY,
	currentMouseY,
}: {
	startMouseY: number;
	currentMouseY: number;
}): "up" | "down" | null {
	if (currentMouseY < startMouseY) return "up";
	if (currentMouseY > startMouseY) return "down";
	return null;
}

function orderedTracks(sceneTracks: SceneTracks): TimelineTrack[] {
	return [...sceneTracks.overlay, sceneTracks.main, ...sceneTracks.audio];
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > TIMELINE_DRAG_THRESHOLD_PX ||
		Math.abs(current.y - origin.y) > TIMELINE_DRAG_THRESHOLD_PX
	);
}

function frameSnappedMouseTime({
	clientX,
	scrollContainer,
	zoomLevel,
	clickOffsetTime,
	fps,
}: {
	clientX: number;
	scrollContainer: HTMLDivElement;
	zoomLevel: number;
	clickOffsetTime: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const mouseTime = getMouseTimeFromClientX({
		clientX,
		containerRect: scrollContainer.getBoundingClientRect(),
		zoomLevel,
		scrollLeft: scrollContainer.scrollLeft,
	});
	const adjusted = maxMediaTime({
		a: ZERO_MEDIA_TIME,
		b: subMediaTime({ a: mouseTime, b: clickOffsetTime }),
	});
	return roundFrameTime({ time: adjusted, fps });
}

function resolveDropTarget({
	clientX,
	clientY,
	elementId,
	trackId,
	tracks,
	viewport,
	zoomLevel,
	snappedTime,
	verticalDragDirection,
	movingElementIds,
}: {
	clientX: number;
	clientY: number;
	elementId: string;
	trackId: string;
	tracks: SceneTracks;
	viewport: ViewportAdapter;
	zoomLevel: number;
	snappedTime: MediaTime;
	verticalDragDirection: "up" | "down" | null;
	movingElementIds?: ReadonlySet<string>;
}): DropTarget | null {
	const containerRect = viewport
		.getTracksContainerEl()
		?.getBoundingClientRect();
	const scrollContainer = viewport.getTracksScrollEl();
	if (!containerRect || !scrollContainer) return null;

	const sourceTrack = orderedTracks(tracks).find(({ id }) => id === trackId);
	const movingElement = sourceTrack?.elements.find(
		({ id }) => id === elementId,
	);
	if (!movingElement) return null;

	const scrollRect = scrollContainer.getBoundingClientRect();
	const headerHeight =
		viewport.getHeaderEl()?.getBoundingClientRect().height ?? 0;

	return computeDropTarget({
		elementType: movingElement.type,
		// A compound clip keeps to the kind of track it is on: an audio-only compound to audio tracks.
		...(movingElement.type === "compound" && sourceTrack && { trackType: sourceTrack.type }),
		mouseX: clientX - scrollRect.left + scrollContainer.scrollLeft,
		mouseY: clientY - scrollRect.top + scrollContainer.scrollTop - headerHeight,
		tracks,
		playheadTime: snappedTime,
		isExternalDrop: false,
		elementDuration: movingElement.duration,
		pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
		zoomLevel,
		startTimeOverride: snappedTime,
		excludeElementId: movingElement.id,
		excludeElementIds: movingElementIds,
		verticalDragDirection,
		getTrackExtraHeight: viewport.getTrackExtraHeight,
	});
}

function resolveGroupMoveForDrop({
	group,
	tracks,
	anchorStartTime,
	dropTarget,
	reservedNewTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	dropTarget: DropTarget;
	reservedNewTrackIds: readonly string[];
}): GroupMoveResult | null {
	const newTracksFallback = () =>
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: {
				kind: "newTracks",
				anchorInsertIndex: dropTarget.trackIndex,
				newTrackIds: [...reservedNewTrackIds],
			},
		});

	if (dropTarget.isNewTrack) return newTracksFallback();

	const targetTrack = orderedTracks(tracks)[dropTarget.trackIndex];
	if (!targetTrack) return null;

	return (
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: { kind: "existingTrack", anchorTargetTrackId: targetTrack.id },
		}) ?? newTracksFallback()
	);
}

// --- Controller ---

export class ElementInteractionController {
	private session: Session = { kind: "idle" };
	// True once the active gesture crossed the drag threshold. Read by
	// onElementClick, which fires after mouseup — by which point the session
	// has already returned to idle, so the "was this a drag?" answer must
	// outlive the session. Reset on the next mousedown.
	private lastGestureWasDrag = false;
	// Set while a move drag runs (agent drafts wait for its release, see gesture-state).
	private endGesture: (() => void) | null = null;
	private gestureOwner: PreviewGesture | null = null;

	private readonly subscribers = new Set<() => void>();
	private readonly depsRef: ElementInteractionDepsRef;

	constructor(args: { depsRef: ElementInteractionDepsRef }) {
		this.depsRef = args.depsRef;
	}

	private get deps(): ElementInteractionDeps {
		return this.depsRef.current;
	}

	/** The view last handed out: the same object while what it shows is the same, so readers can skip a render. */
	private lastView: { drag: DragProgress; view: Extract<ElementDragView, { kind: "dragging" }> } | null = null;
	/** The moving clips' tracks and offsets, which stay the same for a drag. */
	private lastMembers: { group: MoveGroup; sourceTrackIds: Set<string>; memberTimeOffsets: Map<string, MediaTime> } | null = null;

	get view(): ElementDragView {
		if (this.session.kind !== "dragging") return IDLE_VIEW;
		const { mousedown, drag } = this.session;
		const last = this.lastView;
		if (
			last && last.drag === drag && last.view.currentTime === drag.currentTime &&
			last.view.currentMouseY === drag.currentMouseY && sameDropTarget(last.view.dropTarget, drag.dropTarget)
		) {
			return last.view;
		}
		let members = this.lastMembers;
		if (members?.group !== drag.moveGroup) {
			const sourceTrackIds = new Set<string>();
			const memberTimeOffsets = new Map<string, MediaTime>();
			for (const member of drag.moveGroup.members) {
				sourceTrackIds.add(member.trackId);
				memberTimeOffsets.set(member.elementId, member.timeOffset);
			}
			members = this.lastMembers = { group: drag.moveGroup, sourceTrackIds, memberTimeOffsets };
		}
		const view = {
			kind: "dragging" as const,
			anchorElementId: mousedown.elementId,
			trackId: mousedown.trackId,
			sourceTrackIds: members.sourceTrackIds,
			memberTimeOffsets: members.memberTimeOffsets,
			startMouseX: mousedown.origin.x,
			startMouseY: mousedown.origin.y,
			startElementTime: mousedown.startElementTime,
			clickOffsetTime: mousedown.clickOffsetTime,
			currentTime: drag.currentTime,
			currentMouseY: drag.currentMouseY,
			dropTarget: drag.dropTarget,
		};
		this.lastView = { drag, view };
		return view;
	}

	/** The pointer's x during a drag, read live (edge scrolling follows it between renders). */
	getPointerX(): number {
		return this.session.kind === "dragging" ? this.session.drag.currentMouseX : 0;
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		this.subscribers.clear();
		this.gestureOwner?.cancel();
	}

	onElementMouseDown = ({
		event,
		element,
		track,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		// Right-click must not stopPropagation — ContextMenu needs the bubble.
		if (event.button === MOUSE_BUTTON_RIGHT) {
			const ref = { trackId: track.id, elementId: element.id };
			if (!this.deps.selection.isSelected(ref)) {
				this.deps.selection.handleClick({ ...ref, isMultiKey: false });
			}
			return;
		}
		if (event.button !== 0) return;

		event.stopPropagation();
		finishFocusedField(event.currentTarget);
		const currentTrack = orderedTracks(this.deps.scene.getTracks()).find((item) => item.id === track.id);
		const currentElement = currentTrack?.elements.find((item) => item.id === element.id);
		if (!currentElement) return;
		this.gestureOwner = this.deps.timeline.beginPreviewGesture(() => {
			this.lastGestureWasDrag = true;
			this.finishSession();
		});
		this.lastGestureWasDrag = false;

		const ref = { trackId: track.id, elementId: element.id };

		if (event.metaKey || event.ctrlKey || event.shiftKey) {
			this.deps.selection.handleClick({ ...ref, isMultiKey: true });
		}

		const selectedElements = this.deps.selection.isSelected(ref)
			? this.deps.selection.getSelected()
			: [ref];

		const scrollContainer = this.deps.viewport.getTracksScrollEl();
		const zoomLevel = this.deps.viewport.getZoomLevel();
		this.session = {
			kind: "pending",
			mousedown: {
				origin: { x: event.clientX, y: event.clientY },
				scrollLeft: scrollContainer?.scrollLeft ?? 0,
				scrollTop: scrollContainer?.scrollTop ?? 0,
				zoomLevel,
				elementId: element.id,
				trackId: track.id,
				startElementTime: currentElement.startTime,
				clickOffsetTime: pixelToClickOffsetTime({
					clientX: event.clientX,
					elementRect: event.currentTarget.getBoundingClientRect(),
					zoomLevel,
				}),
				selectedElements,
			},
		};
		this.activate();
		this.notify();
	};

	onElementClick = ({
		event,
		element,
		track,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		event.stopPropagation();

		if (this.lastGestureWasDrag) {
			this.lastGestureWasDrag = false;
			return;
		}

		if (event.metaKey || event.ctrlKey || event.shiftKey) return;

		const ref = { trackId: track.id, elementId: element.id };
		if (
			!this.deps.selection.isSelected(ref) ||
			this.deps.selection.getSelected().length > 1
		) {
			this.deps.selection.select(ref);
			return;
		}

		this.deps.selection.clearKeyframeSelection();
	};

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

	/** The drag's snap points, rebuilt only when the scene, the playhead or the moving clips change. */
	private groupSnap: { tracks: SceneTracks; playheadTime: MediaTime; moving: string; index: SnapIndex } | null = null;

	private finishSession(): void {
		this.gestureOwner?.finish();
		this.gestureOwner = null;
		this.groupSnap = null;
		this.lastView = null;
		this.lastMembers = null;
		this.session = { kind: "idle" };
		this.endGesture?.();
		this.endGesture = null;
		this.deactivate();
		this.deps.snap.onChange?.(null);
		this.notify();
	}

	private snapResult({
		frameSnappedTime,
		group,
		fps,
	}: {
		frameSnappedTime: MediaTime;
		group: MoveGroup;
		fps: FrameRate;
	}): { snappedTime: MediaTime; snapPoint: SnapPoint | null } {
		const { snap, input, scene, viewport, playback } = this.deps;

		if (!snap.isEnabled() || input.isShiftHeld()) {
			return { snappedTime: frameSnappedTime, snapPoint: null };
		}

		const tracks = scene.getTracks();
		const playheadTime = playback.getCurrentTime();
		const moving = group.members.map((member) => member.elementId).join("\n");
		const cached = this.groupSnap;
		const index = cached && cached.tracks === tracks && cached.playheadTime === playheadTime && cached.moving === moving
			? cached.index
			: (this.groupSnap = { tracks, playheadTime, moving, index: buildGroupSnapIndex({ group, tracks, playheadTime }) }).index;
		const result = snapGroupEdges({
			group,
			anchorStartTime: frameSnappedTime,
			tracks,
			playheadTime,
			zoomLevel: viewport.getZoomLevel(),
			index,
		});

		// An end that snaps to a point leaves the start off the frame grid when the clip is not a whole
		// number of frames long: keep the start on the grid, the end then lands within half a frame.
		return {
			snappedTime: maxMediaTime({ a: ZERO_MEDIA_TIME, b: roundFrameTime({ time: result.snappedAnchorStartTime, fps }) }),
			snapPoint: result.snapPoint,
		};
	}

	private updateDropTarget({
		clientX,
		clientY,
		mousedown,
		drag,
		snappedTime,
	}: {
		clientX: number;
		clientY: number;
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		snappedTime: MediaTime;
	}): void {
		const { scene, viewport } = this.deps;
		const tracks = scene.getTracks();
		const zoomLevel = viewport.getZoomLevel();

		const anchorDropTarget = resolveDropTarget({
			clientX,
			clientY,
			elementId: mousedown.elementId,
			trackId: mousedown.trackId,
			tracks,
			viewport,
			zoomLevel,
			snappedTime,
			movingElementIds: drag.movingElementIds,
			verticalDragDirection: verticalDirection({
				startMouseY: mousedown.origin.y,
				currentMouseY: clientY,
			}),
		});

		const nextGroupMoveResult = anchorDropTarget
			? resolveGroupMoveForDrop({
					group: drag.moveGroup,
					tracks,
					anchorStartTime: snappedTime,
					dropTarget: anchorDropTarget,
					reservedNewTrackIds: drag.reservedNewTrackIds,
				})
			: null;

		drag.groupMoveResult = nextGroupMoveResult;
		drag.dropTarget =
			anchorDropTarget && (anchorDropTarget.isNewTrack || !nextGroupMoveResult)
				? { ...anchorDropTarget, isNewTrack: true }
				: null;
	}

	private handleMouseMove = ({ clientX, clientY }: MouseEvent): void => {
		const scrollContainer = this.deps.viewport.getTracksScrollEl();
		if (!scrollContainer) return;

		if (this.session.kind === "pending") {
			this.beginDragFromPending({
				mousedown: this.session.mousedown,
				clientX,
				clientY,
				scrollContainer,
			});
			return;
		}

		if (this.session.kind === "dragging") {
			this.updateActiveDrag({
				mousedown: this.session.mousedown,
				drag: this.session.drag,
				clientX,
				clientY,
				scrollContainer,
			});
		}
	};

	private beginDragFromPending({
		mousedown,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			return;
		}

		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const moveGroup = buildMoveGroup({
			anchorRef: {
				trackId: mousedown.trackId,
				elementId: mousedown.elementId,
			},
			selectedElements: [...mousedown.selectedElements],
			tracks: this.deps.scene.getTracks(),
		});
		if (!moveGroup) return;

		const zoomLevel = this.deps.viewport.getZoomLevel();
		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel,
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: moveGroup,
			fps,
		});

		// Ensure the anchor is selected before we render the drag — covers the
		// case where the selection store hasn't committed the mousedown-time
		// selection click yet.
		const anchorRef = {
			trackId: mousedown.trackId,
			elementId: mousedown.elementId,
		};
		if (!this.deps.selection.isSelected(anchorRef)) {
			this.deps.selection.select(anchorRef);
		}

		const drag: DragProgress = {
			moveGroup,
			movingElementIds: moveGroup.members.length > 1
				? new Set(moveGroup.members.map(({ elementId }) => elementId))
				: undefined,
			reservedNewTrackIds: moveGroup.members.map(() => generateUUID()),
			currentTime: snappedTime,
			currentMouseX: clientX,
			currentMouseY: clientY,
			groupMoveResult: null,
			dropTarget: null,
		};

		this.session = { kind: "dragging", mousedown, drag };
		this.lastGestureWasDrag = true;
		this.endGesture ??= beginTimelineGesture();

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.deps.snap.onChange?.(snapPoint);
		this.notify();
	}

	private updateActiveDrag({
		mousedown,
		drag,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel: this.deps.viewport.getZoomLevel(),
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: drag.moveGroup,
			fps,
		});

		drag.currentTime = snappedTime;
		drag.currentMouseX = clientX;
		drag.currentMouseY = clientY;

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.deps.snap.onChange?.(snapPoint);
		this.notify();
	}

	private handleMouseUp = ({ clientX, clientY }: MouseEvent): void => {
		if (this.session.kind === "pending") {
			this.finishSession();
			return;
		}

		if (this.session.kind !== "dragging") return;

		const { mousedown, drag } = this.session;
		const scrollContainer = this.deps.viewport.getTracksScrollEl();
		if (!scrollContainer) {
			this.finishSession();
			return;
		}
		// Returning to the starting pointer position only puts the clip back
		// when the viewport has not moved under it.
		if (
			(scrollContainer.scrollLeft ?? 0) === mousedown.scrollLeft &&
			(scrollContainer.scrollTop ?? 0) === mousedown.scrollTop &&
			this.deps.viewport.getZoomLevel() === mousedown.zoomLevel &&
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			this.lastGestureWasDrag = false;
			this.finishSession();
			return;
		}

		this.updateActiveDrag({ mousedown, drag, clientX, clientY, scrollContainer });
		const { moveGroup, groupMoveResult } = drag;
		if (!groupMoveResult) {
			this.finishSession();
			return;
		}

		const tracks = this.deps.scene.getTracks();
		const planStillValid = moveGroup.members.every((member) => {
			const sourceTrack = orderedTracks(tracks).find(
				({ id }) => id === member.trackId,
			);
			return (
				sourceTrack?.elements.some(({ id }) => id === member.elementId) ?? false
			);
		});
		if (!planStillValid) {
			this.finishSession();
			return;
		}

		const didMove = groupMoveResult.moves.some((move) => {
			const member = moveGroup.members.find(
				(m) => m.elementId === move.elementId,
			);
			const originalStartTime =
				mousedown.startElementTime + (member?.timeOffset ?? 0);
			return (
				member?.trackId !== move.targetTrackId ||
				originalStartTime !== move.newStartTime
			);
		});

		this.finishSession();
		if (didMove || groupMoveResult.createTracks.length > 0) {
			this.deps.timeline.moveElements({
				moves: groupMoveResult.moves,
				createTracks: groupMoveResult.createTracks,
			});
		}

	};
}
