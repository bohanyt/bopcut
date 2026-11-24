"use client";

import { useI18n } from "@/i18n/provider";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Delete02Icon,
	MagicWand05Icon,
	MusicNote03Icon,
	TaskAdd02Icon,
	TextIcon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { OcShapesIcon, OcVideoIcon } from "@/components/icons";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTimelineZoom } from "@/timeline/hooks/use-timeline-zoom";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useContainerSize } from "@/hooks/use-container-size";
import type { MediaTime } from "@/wasm";
import type { ElementDragView, DropTarget } from "@/timeline";
import { TimelineTrackContent } from "./timeline-track";
import { TimelinePlayhead } from "./timeline-playhead";
import { SelectionBox } from "@/selection/selection-box";
import { useBoxSelect } from "@/selection/hooks/use-box-select";
import { SnapIndicator } from "./snap-indicator";
import type { SnapPoint } from "@/timeline/snapping";
import type { TimelineTrack } from "@/timeline";
import {
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
	KEYFRAME_LANE_HEIGHT_PX,
} from "./layout";
import { useElementInteraction } from "@/timeline/hooks/element/use-element-interaction";
import {
	canTrackHaveAudio,
	canTrackBeHidden,
	getTimelineZoomMin,
	getTimelinePaddingPx,
} from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import {
	getTrackHeight,
	getCumulativeHeightBefore,
	getTotalTracksHeight,
} from "./track-layout";
import { SELECTED_TRACK_ROW_CLASS } from "./theme";
import {
	computeTrackExpansionHeight,
	getTrackExpandedRows,
	type ExpandedRow,
} from "./expanded-layout";
import { getWheelScroll } from "./interaction";
import { TimelineToolbar } from "./timeline-toolbar";
import { CompoundBreadcrumb } from "./compound-breadcrumb";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useTimelineSeek } from "@/timeline/hooks/use-timeline-seek";
import { useTimelineDragDrop } from "@/timeline/hooks/use-timeline-drag-drop";
import { TimelineRuler } from "./timeline-ruler";
import {
	TimelineBookmarksRow,
	useBookmarkDrag,
} from "@/timeline/bookmarks/index";
import { useEdgeAutoScroll } from "@/timeline/hooks/use-edge-auto-scroll";
import { useInitialScrollBottom } from "@/timeline/hooks/use-initial-scroll-bottom";
import { useTimelineResize } from "@/timeline/hooks/use-timeline-resize";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditor } from "@/editor/use-editor";
import { useClipWindow } from "./use-clip-window";
import { createTrackClipIndexCache, type TrackClipIndexes } from "./track-clip-index";
import { useTimelineKeyboard } from "./timeline-keyboard";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import type { ElementRef } from "@/timeline";
import { useTimelinePlayhead } from "@/timeline/hooks/use-timeline-playhead";
import { TIMELINE_LAYERS } from "./layers";
import { DragLine } from "./drag-line";
import { invokeAction } from "@/actions";
import { resolveTimelineElementIntersections } from "./selection-hit-testing";
import { cn } from "@/utils/ui";

const EMPTY_IDS: ReadonlySet<string> = new Set();

function groupElementIds(refs: readonly ElementRef[]) {
	const idsByTrack = new Map<string, Set<string>>();
	for (const { trackId, elementId } of refs) {
		let ids = idsByTrack.get(trackId);
		if (!ids) {
			ids = new Set();
			idsByTrack.set(trackId, ids);
		}
		ids.add(elementId);
	}
	return idsByTrack;
}

const TRACKS_CONTAINER_MAX_HEIGHT = 800;
const FALLBACK_CONTAINER_WIDTH = 1000;
const TRACKS_CONTAINER_HEIGHT = { min: 0, max: TRACKS_CONTAINER_MAX_HEIGHT };
const TRACK_ICONS: Record<TimelineTrack["type"], ReactNode> = {
	video: <OcVideoIcon className="text-muted-foreground size-4 shrink-0" />,
	text: (
		<HugeiconsIcon
			icon={TextIcon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	audio: (
		<HugeiconsIcon
			icon={MusicNote03Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	graphic: <OcShapesIcon className="text-muted-foreground size-4 shrink-0" />,
	effect: (
		<HugeiconsIcon
			icon={MagicWand05Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
};

export function Timeline() {
	const { t } = useI18n();
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const {
		selectedElements,
		clearElementSelection,
		setElementSelection,
		mergeElementsIntoSelection,
	} = useElementSelection();
	const editor = useEditor();
	const timeline = editor.timeline;
	const scene = useEditor((currentEditor) =>
		currentEditor.scenes.getActiveSceneOrNull(),
	);
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const [trackIndexCache] = useState(createTrackClipIndexCache);
	const trackIndexes = useMemo(
		() => trackIndexCache.getTracks(tracks),
		[tracks, trackIndexCache],
	);
	const mainTrackId = scene?.tracks.main.id ?? null;
	const seek = (time: MediaTime) => editor.playback.seek({ time });

	const timelineRef = useRef<HTMLDivElement>(null);
	const timelineHeaderRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLDivElement>(null);
	const rulerScrollRef = useRef<HTMLDivElement>(null);
	const tracksContainerRef = useRef<HTMLDivElement>(null);
	const tracksScrollRef = useRef<HTMLDivElement>(null);
	const trackLabelsRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const trackLabelsScrollRef = useRef<HTMLDivElement>(null);

	const [currentSnapPoint, setCurrentSnapPoint] = useState<SnapPoint | null>(
		null,
	);
	const { width: tracksContainerWidth } = useContainerSize({
		containerRef: tracksContainerRef,
	});
	const { height: timelineHeaderHeightValue } = useContainerSize({
		containerRef: timelineHeaderRef,
	});

	const handleSnapPointChange = useCallback((snapPoint: SnapPoint | null) => {
		setCurrentSnapPoint(snapPoint);
	}, []);

	const timelineDuration = timeline.getTotalDuration() || 0;
	const containerWidth = tracksContainerWidth || FALLBACK_CONTAINER_WIDTH;
	const minZoomLevel = getTimelineZoomMin({
		duration: timelineDuration,
		containerWidth,
	});

	const savedViewState = editor.project.getTimelineViewState();

	const { zoomLevel, setZoomLevel, handleWheel, saveScrollPosition } =
		useTimelineZoom({
			containerRef: timelineRef,
			minZoom: minZoomLevel,
			initialZoom: savedViewState?.zoomLevel,
			initialScrollLeft: savedViewState?.scrollLeft,
			tracksScrollRef,
			rulerScrollRef,
		});
	const { isResizing, resizePins, handleResizeStart } = useTimelineResize({
		zoomLevel,
		onSnapPointChange: handleSnapPointChange,
	});

	const { viewportWidth: tracksViewportWidth, windowStart, windowEnd } = useClipWindow({
		scrollRef: tracksScrollRef,
		zoomLevel,
		fallbackWidth: containerWidth,
	});

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	// Stable refs so the wheel listener never goes stale
	const setZoomLevelRef = useRef(setZoomLevel);
	useEffect(() => {
		setZoomLevelRef.current = setZoomLevel;
	}, [setZoomLevel]);

	const saveScrollPositionRef = useRef(saveScrollPosition);
	useEffect(() => {
		saveScrollPositionRef.current = saveScrollPosition;
	}, [saveScrollPosition]);

	const minZoomLevelRef = useRef(minZoomLevel);
	useEffect(() => {
		minZoomLevelRef.current = minZoomLevel;
	}, [minZoomLevel]);

	// Pushes tracks scroll position to the two overflow:hidden followers
	// (ruler and track labels). Called from the wheel handler (before paint,
	// zero lag) and from onScroll on the tracks area (covers scrollbar drag).
	const syncFollowers = useCallback(() => {
		const tracks = tracksScrollRef.current;
		if (!tracks) return;
		if (rulerScrollRef.current) {
			rulerScrollRef.current.scrollLeft = tracks.scrollLeft;
		}
		if (trackLabelsScrollRef.current) {
			trackLabelsScrollRef.current.scrollTop = tracks.scrollTop;
		}
	}, []);

	// Single non-passive capture listener owns all wheel input. Prevents any
	// native scroll or browser zoom from firing inside the timeline.
	useEffect(() => {
		const container = timelineRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let scrolledWithAlt = false;

		const onWheel = (e: WheelEvent) => {
			const isZoom = e.ctrlKey || e.metaKey;

			if (isZoom) {
				e.preventDefault();
				const normalizedDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				pendingZoomDelta += normalizedDelta;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const frameRawDelta = pendingZoomDelta;
						const cappedDelta =
							Math.sign(frameRawDelta) * Math.min(Math.abs(frameRawDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);
						setZoomLevelRef.current((prev) => prev * zoomFactor);
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}
				return;
			}

			const tracks = tracksScrollRef.current;
			if (!tracks) return;

			if (e.altKey) scrolledWithAlt = true;

			e.preventDefault();

			const scroll = getWheelScroll(e);
			if (scroll.axis === "x") {
				tracks.scrollLeft = Math.max(0, tracks.scrollLeft + scroll.delta);
			} else {
				tracks.scrollTop = Math.max(0, tracks.scrollTop + scroll.delta);
			}

			syncFollowers();
			saveScrollPositionRef.current();
		};

		// Releasing Alt would otherwise move the focus to the browser's menu.
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key !== "Alt" || !scrolledWithAlt) return;
			scrolledWithAlt = false;
			e.preventDefault();
		};

		container.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});
		window.addEventListener("keyup", onKeyUp);
		return () => {
			container.removeEventListener("wheel", onWheel, { capture: true });
			window.removeEventListener("keyup", onKeyUp);
			if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
		};
	}, [syncFollowers]);

	useInitialScrollBottom({
		tracksScrollRef,
		trackLabelsScrollRef,
		isReady: tracks.length > 0,
	});

	const { dragView, handleElementMouseDown, handleElementClick } =
		useElementInteraction({
		zoomLevel,
		tracksContainerRef,
		tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});
	const isElementDragging = dragView.kind === "dragging";
	const dragViewRef = useCommittedRef(dragView);
	const getDragPointerX = useCallback(() => {
		const view = dragViewRef.current;
		return view.kind === "dragging" ? view.currentMouseX : 0;
	}, [dragViewRef]);

	const {
		dragState: bookmarkDragState,
		handleBookmarkMouseDown,
		lastMouseXRef: bookmarkLastMouseXRef,
	} = useBookmarkDrag({
		zoomLevel,
		scrollRef: tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});

	const { handleRulerPointerDown: handlePlayheadRulerPointerDown, handlePlayheadPointerDown } =
		useTimelinePlayhead({
			zoomLevel,
			rulerRef,
			rulerScrollRef,
			tracksScrollRef,
			playheadRef,
		});

	const { isDragOver, dropTarget, dragProps } = useTimelineDragDrop({
		containerRef: tracksContainerRef,
		tracksScrollRef,
		zoomLevel,
	});

	const {
		selectionBox,
		handleMouseDown: handleSelectionMouseDown,
		isSelecting,
		shouldIgnoreClick,
	} = useBoxSelect({
		containerRef: tracksContainerRef,
		selectedIds: selectedElements,
		anchorId: null,
		getIsAdditiveSelection: (event) =>
			event.shiftKey || event.ctrlKey || event.metaKey,
		resolveIntersections: ({ startPos, currentPos }) => {
			if (!tracksContainerRef.current) {
				return [];
			}

			return resolveTimelineElementIntersections({
				container: tracksContainerRef.current,
				scrollContainer: tracksScrollRef.current,
				tracks,
				indexes: trackIndexes,
				zoomLevel,
				startPos,
				currentPos,
				getTrackExpansionHeight,
			});
		},
		onSelectionChange: ({ intersectedIds, isAdditive }) => {
			if (isAdditive) {
				mergeElementsIntoSelection({ elements: intersectedIds });
			} else {
				setElementSelection({ elements: intersectedIds });
			}
		},
	});

	const contentWidth = timelineTimeToPixels({
		time: timelineDuration,
		zoomLevel,
	});
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom: minZoomLevel,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx,
		containerWidth,
	);
	const hasHorizontalScrollbar =
		dynamicTimelineWidth > (tracksViewportWidth || containerWidth);

	useEdgeAutoScroll({
		isActive: bookmarkDragState.isDragging,
		getMouseClientX: () => bookmarkLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	useEdgeAutoScroll({
		isActive: isElementDragging,
		getMouseClientX: getDragPointerX,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	const showSnapIndicator =
		snappingEnabled &&
		currentSnapPoint !== null &&
		(isElementDragging || bookmarkDragState.isDragging || isResizing);

	const {
		handleTracksMouseDown,
		handleTracksClick,
		handleRulerMouseDown,
		handleRulerClick,
	} = useTimelineSeek({
		playheadRef,
		trackLabelsRef,
		rulerScrollRef,
		tracksScrollRef,
		zoomLevel,
		duration: timeline.getTotalDuration(),
		isSelecting,
		clearSelectedElements: clearElementSelection,
		seek,
	});

	const trackEvents = useCommittedRef({ handleSelectionMouseDown, handleTracksMouseDown, shouldIgnoreClick });
	const onTrackMouseDown = useCallback((event: React.MouseEvent) => {
		trackEvents.current.handleSelectionMouseDown(event);
		trackEvents.current.handleTracksMouseDown(event);
	}, [trackEvents]);
	const ignoreTrackClick = useCallback(() => trackEvents.current.shouldIgnoreClick(), [trackEvents]);

	const timelineHeaderHeight =
		timelineHeaderHeightValue + TIMELINE_CONTENT_TOP_PADDING_PX;

	return (
		<section
			className={
				"panel bg-background relative flex h-full flex-col overflow-hidden rounded-sm border"
			}
			{...dragProps}
			aria-label={t("shortcuts.category.timeline")}
		>
			<TimelineToolbar
				zoomLevel={zoomLevel}
				minZoom={minZoomLevel}
				setZoomLevel={({ zoom }) => setZoomLevel(zoom)}
			/>
			<CompoundBreadcrumb />

			<div className="relative flex flex-1 overflow-hidden" ref={timelineRef}>
				<TrackLabelsPanel
					trackLabelsRef={trackLabelsRef}
					trackLabelsScrollRef={trackLabelsScrollRef}
					timelineHeaderHeight={timelineHeaderHeight}
					hasHorizontalScrollbar={hasHorizontalScrollbar}
					getTrackExpansionHeight={getTrackExpansionHeight}
				/>

				<div
					className="relative isolate flex flex-1 flex-col overflow-hidden"
					ref={tracksContainerRef}
				>
					<SelectionBox
						bounds={selectionBox?.bounds ?? null}
					/>
					<DragLine
						dropTarget={dropTarget}
						tracks={tracks}
						isVisible={isDragOver && !dropTarget?.targetElement}
						headerHeight={timelineHeaderHeight}
					/>
					<DragLine
						dropTarget={isElementDragging ? dragView.dropTarget : null}
						tracks={tracks}
						isVisible={isElementDragging}
						headerHeight={timelineHeaderHeight}
					/>

					<div ref={rulerScrollRef} className="shrink-0 overflow-hidden">
						<div
							ref={timelineHeaderRef}
							className="flex flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							<TimelineRuler
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								rulerRef={rulerRef}
								tracksScrollRef={rulerScrollRef}
								handleWheel={handleWheel}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingPointerDown={handleRulerMouseDown}
								handleRulerPointerDown={handlePlayheadRulerPointerDown}
							/>
							<TimelineBookmarksRow
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								dragState={bookmarkDragState}
								onBookmarkMouseDown={handleBookmarkMouseDown}
								handleWheel={handleWheel}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingPointerDown={handleRulerMouseDown}
								handleRulerPointerDown={handlePlayheadRulerPointerDown}
							/>
						</div>
					</div>

					<ScrollArea
						className="flex-1"
						ref={tracksScrollRef}
						onScroll={() => {
							syncFollowers();
							saveScrollPosition();
						}}
					>
						<div
							className="flex min-h-full flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (tracks container background); direct-target clicks here originate box-select or clear selection. Keyboard control is global timeline shortcuts. */}
							<div
								className="relative shrink-0"
								style={{
									height: `${
										Math.max(
											TRACKS_CONTAINER_HEIGHT.min,
											Math.min(
												TRACKS_CONTAINER_HEIGHT.max,
												getTotalTracksHeight({
													tracks,
													getExtraHeight: getTrackExpansionHeight,
												}),
											),
										) + TIMELINE_CONTENT_TOP_PADDING_PX
									}px`,
								}}
								onMouseDown={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksClick(event);
								}}
							>
								{tracks.length > 0 && (
									<TimelineTrackRows
										indexes={trackIndexes}
										tracks={tracks}
										mainTrackId={mainTrackId}
										windowStart={windowStart}
										windowEnd={windowEnd}
										selectedElements={selectedElements}
										resizePins={resizePins}
										expandedElementIds={expandedElementIds}
										getTrackExpansionHeight={getTrackExpansionHeight}
										zoomLevel={zoomLevel}
										dragView={dragView}
										onResizeStart={handleResizeStart}
										onElementMouseDown={handleElementMouseDown}
										onElementClick={handleElementClick}
										onTrackMouseDown={onTrackMouseDown}
										onTrackMouseUp={handleTracksClick}
										shouldIgnoreClick={ignoreTrackClick}
										isDragOver={isDragOver}
										dropTarget={dropTarget}
									/>
								)}
							</div>
							<TimelineGutter
								onMouseDown={(event) => {
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={handleTracksClick}
							/>
						</div>
					</ScrollArea>

					<TimelinePlayhead
						zoomLevel={zoomLevel}
						hasHorizontalScrollbar={hasHorizontalScrollbar}
						tracksScrollRef={tracksScrollRef}
						timelineRef={timelineRef}
						playheadRef={playheadRef}
						onPointerDown={handlePlayheadPointerDown}
						isSnappingToPlayhead={
							showSnapIndicator && currentSnapPoint?.type === "playhead"
						}
					/>
				</div>
				<SnapIndicator
					snapPoint={currentSnapPoint}
					zoomLevel={zoomLevel}
					timelineRef={timelineRef}
					tracksScrollRef={tracksScrollRef}
					isVisible={showSnapIndicator}
				/>
			</div>
		</section>
	);
}

function TrackLabelsPanel({
	trackLabelsRef,
	trackLabelsScrollRef,
	timelineHeaderHeight,
	hasHorizontalScrollbar,
	getTrackExpansionHeight,
}: {
	trackLabelsRef: React.RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineHeaderHeight: number;
	hasHorizontalScrollbar: boolean;
	getTrackExpansionHeight: (trackIndex: number) => number;
}) {
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);
	const trackExpandedRowsMap = useMemo(
		() =>
			tracks.map((track) =>
				getTrackExpandedRows({ track, expandedElementIds }),
			),
		[tracks, expandedElementIds],
	);

	return (
		<div
			className="flex shrink-0 flex-col border-r"
			style={{ width: `${TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX}px` }}
		>
			<div
				className="shrink-0"
				style={{ height: timelineHeaderHeight || 48 }}
			/>
			<div ref={trackLabelsRef} className="flex-1 overflow-hidden">
				<div ref={trackLabelsScrollRef} className="size-full overflow-hidden">
					{tracks.length > 0 && (
						<div
							className="flex flex-col"
							style={{ gap: `${TIMELINE_TRACK_GAP_PX}px` }}
						>
							{tracks.map((track, index) => {
								const expandedRows = trackExpandedRowsMap[index];
								const baseHeight = getTrackHeight({ type: track.type });

								return (
									<div
										key={track.id}
										className={cn(
											"group flex flex-col",
											tracksWithSelection.has(track.id) &&
												SELECTED_TRACK_ROW_CLASS,
										)}
										style={{
											height: `${baseHeight + getTrackExpansionHeight(index)}px`,
										}}
									>
										<div
											className="flex shrink-0 items-center justify-end gap-2 px-3"
											style={{ height: `${baseHeight}px` }}
										>
											{canTrackHaveAudio(track) && (
												<TrackToggleIcon
													isOff={track.muted}
													icons={{
														on: VolumeHighIcon,
														off: VolumeOffIcon,
													}}
													onClick={() =>
														editor.timeline.toggleTrackMute({
															trackId: track.id,
														})
													}
												/>
											)}
											{canTrackBeHidden(track) && (
												<TrackToggleIcon
													isOff={track.hidden}
													icons={{
														on: ViewIcon,
														off: ViewOffSlashIcon,
													}}
													onClick={() =>
														editor.timeline.toggleTrackVisibility({
															trackId: track.id,
														})
													}
												/>
											)}
											<TrackIcon track={track} />
										</div>
										{expandedRows.length > 0 && (
											<PropertyTree rows={expandedRows} />
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
			<div
				className="bg-background shrink-0"
				style={{
					height: hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX : 0,
				}}
			/>
		</div>
	);
}

function TimelineTrackRows({
	tracks,
	indexes,
	mainTrackId,
	windowStart,
	windowEnd,
	selectedElements,
	resizePins,
	expandedElementIds,
	getTrackExpansionHeight,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	isDragOver,
	dropTarget,
}: {
	tracks: TimelineTrack[];
	indexes: TrackClipIndexes;
	mainTrackId: string | null;
	windowStart: number;
	windowEnd: number;
	selectedElements: readonly ElementRef[];
	resizePins: readonly ElementRef[];
	expandedElementIds: ReadonlySet<string>;
	getTrackExpansionHeight: (trackIndex: number) => number;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: React.ComponentProps<
		typeof TimelineTrackContent
	>["onResizeStart"];
	onElementMouseDown: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementMouseDown"];
	onElementClick: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementClick"];
	onTrackMouseDown: (event: React.MouseEvent) => void;
	onTrackMouseUp: (event: React.MouseEvent) => void;
	shouldIgnoreClick: () => boolean;
	isDragOver: boolean;
	dropTarget: DropTarget | null;
}) {
	const { t } = useI18n();
	const { timeline, media } = useEditor();
	const keyboard = useTimelineKeyboard(tracks, () => media.getAssets());
	const selectedByTrack = useMemo(
		() => groupElementIds(selectedElements),
		[selectedElements],
	);
	const resizeByTrack = useMemo(
		() => groupElementIds(resizePins),
		[resizePins],
	);
	const expandedByTrack = useMemo(
		() =>
			tracks.map(({ id }) => {
				if (expandedElementIds.size === 0) return EMPTY_IDS;
				const index = indexes.get(id);
				return new Set([...expandedElementIds].filter((id) => index?.get(id)));
			}),
		[tracks, indexes, expandedElementIds],
	);
	const dragged = dragView.kind === "dragging" ? dragView : undefined;

	return (
		<div {...keyboard.bindings}>
			{tracks.map((track, index) => (
				<ContextMenu key={track.id}>
					<ContextMenuTrigger asChild>
						<div
							data-timeline-track-id={track.id}
							className={cn(
								"absolute right-0 left-0 transition-colors",
								selectedByTrack.has(track.id) && SELECTED_TRACK_ROW_CLASS,
							)}
							style={{
								zIndex: dragged?.sourceTrackIds.has(track.id)
									? TIMELINE_LAYERS.trackContent + 1
									: undefined,
								top: `${TIMELINE_CONTENT_TOP_PADDING_PX + getCumulativeHeightBefore({ tracks, trackIndex: index, getExtraHeight: getTrackExpansionHeight })}px`,
								height: `${getTrackHeight({ type: track.type }) + getTrackExpansionHeight(index)}px`,
							}}
						>
							<TimelineTrackContent
								track={track}
								index={indexes.get(track.id)!}
								focusRequest={
									keyboard.pending?.trackId === track.id
										? keyboard.pending.elementId
										: undefined
								}
								zoomLevel={zoomLevel}
								dragView={
									dragged?.sourceTrackIds.has(track.id) ? dragged : undefined
								}
								windowStart={windowStart}
								windowEnd={windowEnd}
								selectedIds={selectedByTrack.get(track.id)}
								resizeIds={resizeByTrack.get(track.id)}
								expandedIds={expandedByTrack[index]}
								onResizeStart={onResizeStart}
								onElementMouseDown={onElementMouseDown}
								onElementClick={onElementClick}
								onTrackMouseDown={onTrackMouseDown}
								onTrackMouseUp={onTrackMouseUp}
								shouldIgnoreClick={shouldIgnoreClick}
								targetElementId={
									isDragOver && dropTarget?.targetElement?.trackId === track.id
										? dropTarget.targetElement.elementId
										: null
								}
							/>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent className="w-40">
						<ContextMenuItem
							icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								invokeAction("paste-copied");
							}}
						>
							{t("timeline.pasteElements")}
						</ContextMenuItem>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={VolumeHighIcon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								timeline.toggleTrackMute({ trackId: track.id });
							}}
						>
							{canTrackHaveAudio(track) && track.muted
								? t("timeline.unmuteTrack")
								: t("timeline.muteTrack")}
						</ContextMenuItem>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={ViewIcon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								timeline.toggleTrackVisibility({ trackId: track.id });
							}}
						>
							{canTrackBeHidden(track) && track.hidden
								? t("timeline.showTrack")
								: t("timeline.hideTrack")}
						</ContextMenuItem>
						{track.id !== mainTrackId && (
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Delete02Icon} />}
								onClick={(event: React.MouseEvent) => {
									event.stopPropagation();
									timeline.removeTrack({ trackId: track.id });
								}}
								variant="destructive"
							>
								{t("timeline.deleteTrack")}
							</ContextMenuItem>
						)}
					</ContextMenuContent>
				</ContextMenu>
			))}
		</div>
	);
}

function TimelineGutter({
	onMouseDown,
	onClick,
}: {
	onMouseDown: (event: React.MouseEvent) => void;
	onClick: (event: React.MouseEvent) => void;
}) {
	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (empty space below tracks); clicks here clear selection. Keyboard control is global timeline shortcuts.
		<div className="flex-1" onMouseDown={onMouseDown} onClick={onClick} />
	);
}

function TrackIcon({ track }: { track: TimelineTrack }) {
	return <>{TRACK_ICONS[track.type]}</>;
}

function TrackToggleIcon({
	isOff,
	icons,
	onClick,
}: {
	isOff: boolean;
	icons: {
		on: IconSvgElement;
		off: IconSvgElement;
	};
	onClick: () => void;
}) {
	return (
		<>
			{isOff ? (
				<HugeiconsIcon
					icon={icons.off}
					className="text-destructive size-4 cursor-pointer"
					onClick={onClick}
				/>
			) : (
				<HugeiconsIcon
					icon={icons.on}
					className="text-muted-foreground size-4 cursor-pointer"
					onClick={onClick}
				/>
			)}
		</>
	);
}

function PropertyTree({ rows }: { rows: ExpandedRow[] }) {
	const { t } = useI18n();
	return (
		<div className="flex flex-col overflow-hidden">
			{rows.map((row) => (
				<div
					key={row.propertyPath}
					className={cn("flex shrink-0 items-center px-3 bg-muted/50")}
					style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
				>
					<span className="text-muted-foreground truncate text-xs leading-none">
						{row.labelKey ? t(row.labelKey) : row.fallbackLabel ?? row.propertyPath}
					</span>
				</div>
			))}
		</div>
	);
}
