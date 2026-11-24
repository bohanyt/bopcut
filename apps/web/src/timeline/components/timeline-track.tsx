"use client";

import { useI18n } from "@/i18n/provider";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { findTrackInSceneTracks } from "@/timeline";
import type { TrackClipIndexes } from "./track-clip-index";
import { buildClipIndex } from "./clip-window";
import { addMediaTime } from "@/wasm";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragView } from "@/timeline";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	index: NonNullable<ReturnType<TrackClipIndexes["get"]>>;
	focusRequest?: string;
	zoomLevel: number;
	dragView?: Extract<ElementDragView, { kind: "dragging" }>;
	windowStart: number;
	windowEnd: number;
	selectedIds?: ReadonlySet<string>;
	resizeIds?: ReadonlySet<string>;
	expandedIds: ReadonlySet<string>;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
}

export const TimelineTrackContent = memo(function TimelineTrackContent({
	track,
	index,
	focusRequest,
	zoomLevel,
	dragView,
	windowStart,
	windowEnd,
	selectedIds,
	resizeIds,
	expandedIds,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
}: TimelineTrackContentProps) {
	const { t } = useI18n();
	const editor = useEditor();
	const trackId = track.id;
	const trackType = track.type;
	const clipTrack = useMemo(
		() => ({ id: trackId, type: trackType }),
		[trackId, trackType],
	);
	const trackRef = useCommittedRef(track);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [menuId, setMenuId] = useState<string | null>(null);
	const [pressedId, setPressedId] = useState<string | null>(null);
	useEffect(() => {
		if (pressedId === null) return;
		const release = () => setPressedId(null);
		document.addEventListener("mouseup", release);
		window.addEventListener("blur", release);
		return () => {
			document.removeEventListener("mouseup", release);
			window.removeEventListener("blur", release);
		};
	}, [pressedId]);
	const subscribe = useCallback(
		(listener: () => void) => editor.timeline.subscribe(listener),
		[editor],
	);
	const getPreviewElements = useCallback(() => {
		const preview = editor.timeline.getPreviewTracks();
		const committed = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!preview || !committed || preview === committed) return null;
		const previewTrack = findTrackInSceneTracks({ tracks: preview, trackId });
		const committedTrack = findTrackInSceneTracks({
			tracks: committed,
			trackId,
		});
		return previewTrack === committedTrack
			? null
			: (previewTrack?.elements ?? null);
	}, [editor, trackId]);
	const previewElements = useSyncExternalStore(
		subscribe,
		getPreviewElements,
		getPreviewElements,
	);
	const displayIndex = useMemo(
		() =>
			previewElements
				? buildClipIndex<TimelineElementType>(previewElements)
				: index,
		[previewElements, index],
	);
	const clips = useMemo(() => {
		const pins = new Set(selectedIds);
		for (const id of expandedIds) pins.add(id);
		for (const id of resizeIds ?? []) pins.add(id);
		for (const id of dragView?.memberTimeOffsets.keys() ?? []) pins.add(id);
		if (focusedId) pins.add(focusedId);
		if (menuId) pins.add(menuId);
		if (pressedId) pins.add(pressedId);
		if (focusRequest) pins.add(focusRequest);
		return displayIndex.query(windowStart, windowEnd, pins);
	}, [
		selectedIds,
		expandedIds,
		resizeIds,
		dragView?.memberTimeOffsets,
		focusedId,
		menuId,
		pressedId,
		focusRequest,
		displayIndex,
		windowStart,
		windowEnd,
	]);

	const resize = useCallback<
		React.ComponentProps<typeof TimelineElement>["onResizeStart"]
	>(
		(params) => onResizeStart({ ...params, track: trackRef.current }),
		[onResizeStart, trackRef],
	);
	const mouseDown = useCallback<
		React.ComponentProps<typeof TimelineElement>["onElementMouseDown"]
	>(
		(params) => {
			if (params.event.button === 0) setPressedId(params.element.id);
			onElementMouseDown({ ...params, track: trackRef.current });
		},
		[onElementMouseDown, trackRef],
	);
	const click = useCallback<
		React.ComponentProps<typeof TimelineElement>["onElementClick"]
	>(
		(params) => onElementClick({ ...params, track: trackRef.current }),
		[onElementClick, trackRef],
	);
	const changeMenu = useCallback((id: string, open: boolean) => {
		setMenuId((current) => (open ? id : current === id ? null : current));
	}, []);

	return (
		<div className="relative size-full">
			<button
				type="button"
				data-timeline-track-button
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={t("timeline.selectTrack", { name: track.name })}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					clips.map((displayElement) => {
						const { id } = displayElement;
						const element = index.get(id);
						if (!element) return null;
						const dragOffset = dragView?.memberTimeOffsets.get(id);

						return (
							<TimelineElement
								key={id}
								element={element}
								displayElement={displayElement}
								track={clipTrack}
								zoomLevel={zoomLevel}
								isSelected={selectedIds?.has(id) ?? false}
								isExpanded={expandedIds.has(id)}
								onResizeStart={resize}
								onElementMouseDown={mouseDown}
								onElementClick={click}
								onFocusChange={setFocusedId}
								onMenuChange={changeMenu}
								draggedStartTime={
									dragView && dragOffset !== undefined
										? addMediaTime({ a: dragView.currentTime, b: dragOffset })
										: undefined
								}
								dragOffsetY={
									dragView && dragOffset !== undefined
										? dragView.currentMouseY - dragView.startMouseY
										: 0
								}
								isDropTarget={id === targetElementId}
							/>
						);
					})
				)}
			</div>
		</div>
	);
});
