import {
	useState,
	useCallback,
	useEffect,
	useRef,
	type RefObject,
} from "react";
import { useEditor } from "@/editor/use-editor";
import { finishFocusedField } from "@/utils/browser";
import { registerCanceller } from "@/editor/cancel-interaction";
import { beginTimelineGesture } from "@/timeline/gesture-state";
import { useShiftKey } from "@/hooks/use-shift-key";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getBookmarkSnapPoints } from "../snap-source";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import type { Bookmark } from "@/timeline";
import { roundFrameTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export interface BookmarkDragState {
	isDragging: boolean;
	bookmark: Bookmark | null;
	currentTime: MediaTime;
}

interface PendingBookmarkDrag {
	bookmark: Bookmark;
	startMouseX: number;
	startMouseY: number;
}

interface UseBookmarkDragProps {
	zoomLevel: number;
	scrollRef: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useBookmarkDrag({
	zoomLevel,
	scrollRef,
	snappingEnabled,
	onSnapPointChange,
}: UseBookmarkDragProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const tracks = editor.scenes.getActiveScene().tracks;
	const activeScene = editor.scenes.getActiveScene();
	const bookmarks = activeScene?.bookmarks ?? [];
	const duration = editor.timeline.getTotalDuration();

	const [dragState, setDragState] = useState<BookmarkDragState>({
		isDragging: false,
		bookmark: null,
		currentTime: ZERO_MEDIA_TIME,
	});
	const [isPendingDrag, setIsPendingDrag] = useState(false);
	const pendingDragRef = useRef<PendingBookmarkDrag | null>(null);
	const lastMouseXRef = useRef(0);
	const releaseGesture = useRef<(() => void) | undefined>(undefined);
	const release = useCallback(() => {
		releaseGesture.current?.();
		releaseGesture.current = undefined;
	}, []);
	useEffect(() => release, [release]);

	const startDrag = useCallback(
		({
			bookmark,
			initialCurrentTime,
		}: {
			bookmark: Bookmark;
			initialCurrentTime: MediaTime;
		}) => {
			releaseGesture.current ??= beginTimelineGesture();
			setDragState({
				isDragging: true,
				bookmark,
				currentTime: initialCurrentTime,
			});
		},
		[],
	);

	const endDrag = useCallback(() => {
		release();
		pendingDragRef.current = null;
		setIsPendingDrag(false);
		setDragState({
			isDragging: false,
			bookmark: null,
			currentTime: ZERO_MEDIA_TIME,
		});
	}, [release]);

	useEffect(() => {
		if (!dragState.isDragging && !isPendingDrag) return;
		const cancel = () => {
			endDrag();
			onSnapPointChange?.(null);
		};
		const unregister = registerCanceller({ fn: cancel });
		window.addEventListener("blur", cancel);
		window.addEventListener("pointercancel", cancel);
		return () => {
			unregister();
			window.removeEventListener("blur", cancel);
			window.removeEventListener("pointercancel", cancel);
		};
	}, [dragState.isDragging, isPendingDrag, endDrag, onSnapPointChange]);

	const getSnapResult = useCallback(
		({
			rawTime,
			excludeBookmarkTime,
		}: {
			rawTime: MediaTime;
			excludeBookmarkTime: MediaTime;
		}): { snappedTime: MediaTime; snapPoint: SnapPoint | null } => {
			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			if (!shouldSnap) {
				return { snappedTime: rawTime, snapPoint: null };
			}

			const snapPoints = buildTimelineSnapPoints({
				sources: [
					() => getElementEdgeSnapPoints({ tracks }),
					() => getPlayheadSnapPoints({ playheadTime: editor.playback.getCurrentTime() }),
					() => getBookmarkSnapPoints({ bookmarks, excludeBookmarkTime }),
					() => getAnimationKeyframeSnapPointsForTimeline({ tracks }),
				],
			});
			const result = resolveTimelineSnap({
				targetTime: rawTime,
				snapPoints,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return {
				snappedTime: result.snappedTime,
				snapPoint: result.snapPoint,
			};
		},
		[
			snappingEnabled,
			tracks,
			editor,
			bookmarks,
			zoomLevel,
			isShiftHeldRef,
		],
	);

	useEffect(() => {
		if (!dragState.isDragging && !isPendingDrag) return;

		const handleMouseMove = (event: MouseEvent) => {
			lastMouseXRef.current = event.clientX;

			const scrollContainer = scrollRef.current;
			if (!scrollContainer) return;

			if (isPendingDrag && pendingDragRef.current) {
				const { startMouseX, startMouseY, bookmark } =
					pendingDragRef.current;
				const deltaX = Math.abs(event.clientX - startMouseX);
				const deltaY = Math.abs(event.clientY - startMouseY);

				if (
					deltaX <= TIMELINE_DRAG_THRESHOLD_PX &&
					deltaY <= TIMELINE_DRAG_THRESHOLD_PX
				) {
					return;
				}

				const activeProject = editor.project.getActive();
				if (!activeProject) return;

				const scrollLeft = scrollContainer.scrollLeft;
				const mouseTime = getMouseTimeFromClientX({
					clientX: event.clientX,
					containerRect: scrollContainer.getBoundingClientRect(),
					zoomLevel,
					scrollLeft,
				});
				const clampedTime =
					mouseTime > duration ? duration : mouseTime;
				const frameSnappedTime = roundFrameTime({
					time: clampedTime,
					fps: activeProject.settings.fps,
				});
				const { snappedTime: initialTime } = getSnapResult({
					rawTime: frameSnappedTime,
					excludeBookmarkTime: bookmark.time,
				});

				startDrag({
					bookmark,
					initialCurrentTime: initialTime,
				});
				pendingDragRef.current = null;
				setIsPendingDrag(false);
				return;
			}

			if (!dragState.isDragging || !dragState.bookmark) return;

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			const scrollLeft = scrollContainer.scrollLeft;
			const mouseTime = getMouseTimeFromClientX({
				clientX: event.clientX,
				containerRect: scrollContainer.getBoundingClientRect(),
				zoomLevel,
				scrollLeft,
			});
			const clampedTime =
				mouseTime > duration ? duration : mouseTime;
			const frameSnappedTime = roundFrameTime({
				time: clampedTime,
				fps: activeProject.settings.fps,
			});
			const snapResult = getSnapResult({
				rawTime: frameSnappedTime,
				excludeBookmarkTime: dragState.bookmark.time,
			});

			// Moves within one frame keep the state, so the timeline does not re-render on every pixel.
			setDragState((previousDragState) =>
				previousDragState.currentTime === snapResult.snappedTime
					? previousDragState
					: { ...previousDragState, currentTime: snapResult.snappedTime },
			);
			onSnapPointChange?.(snapResult.snapPoint);
		};

		document.addEventListener("mousemove", handleMouseMove);
		return () => document.removeEventListener("mousemove", handleMouseMove);
	}, [
		dragState.isDragging,
		dragState.bookmark,
		zoomLevel,
		duration,
		editor.project,
		scrollRef,
		isPendingDrag,
		startDrag,
		getSnapResult,
		onSnapPointChange,
	]);

	useEffect(() => {
		if (!dragState.isDragging) return;

		const handleMouseUp = () => {
			if (!dragState.bookmark) {
				endDrag();
				onSnapPointChange?.(null);
				return;
			}

			const clampedTime =
				dragState.currentTime > duration ? duration : dragState.currentTime;

			editor.scenes.moveBookmark({
				fromTime: dragState.bookmark.time,
				toTime: clampedTime,
				bookmark: dragState.bookmark,
			});

			endDrag();
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [
		dragState.isDragging,
		dragState.bookmark,
		dragState.currentTime,
		duration,
		endDrag,
		onSnapPointChange,
		editor.scenes,
	]);

	useEffect(() => {
		if (!isPendingDrag) return;

		const handleMouseUp = () => {
			pendingDragRef.current = null;
			setIsPendingDrag(false);
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [isPendingDrag, onSnapPointChange]);

	const handleBookmarkMouseDown = useCallback(
		({ event, bookmark }: { event: React.MouseEvent; bookmark: Bookmark }) => {
			if (event.button !== 0) return;

			finishFocusedField(event.currentTarget);
			event.preventDefault();
			event.stopPropagation();

			pendingDragRef.current = {
				bookmark,
				startMouseX: event.clientX,
				startMouseY: event.clientY,
			};
			setIsPendingDrag(true);
		},
		[],
	);

	return {
		dragState,
		handleBookmarkMouseDown,
		lastMouseXRef,
	};
}
