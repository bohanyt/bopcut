import { useI18n } from "@/i18n/provider";
import { type JSX, useRef } from "react";
import { AiSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { requestAgentCheck, timeAtClientX } from "@/timeline/bookmarks/agent-check";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { TIMELINE_RULER_HEIGHT_PX } from "./layout";
import { DEFAULT_FPS } from "@/fps/defaults";
import { useEditor } from "@/editor/use-editor";
import { getRulerConfig, shouldShowLabel } from "@/timeline/ruler-utils";
import { useScrollPosition } from "@/timeline/hooks/use-scroll-position";
import { TimelineTick } from "./timeline-tick";

interface TimelineRulerProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	rulerRef: React.Ref<HTMLDivElement>;
	tracksScrollRef: React.RefObject<HTMLElement | null>;
	handleWheel: (e: React.WheelEvent) => void;
	handleTimelineContentClick: (e: React.MouseEvent) => void;
	handleRulerTrackingPointerDown: (e: React.PointerEvent) => void;
	handleRulerPointerDown: (e: React.PointerEvent) => void;
}

export function TimelineRuler({
	zoomLevel,
	dynamicTimelineWidth,
	rulerRef,
	tracksScrollRef,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingPointerDown,
	handleRulerPointerDown,
}: TimelineRulerProps) {
	const { t } = useI18n();
	const editor = useEditor();
	// Where the menu was opened, and whether its check request opened a note.
	const menuTime = useRef<MediaTime>(ZERO_MEDIA_TIME);
	const askedAgent = useRef(false);
	const durationTicks = useEditor((e) => e.timeline.getTotalDuration());
	const durationSeconds = mediaTimeToSeconds({ time: durationTicks });
	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const visibleDurationSeconds = dynamicTimelineWidth / pixelsPerSecond;
	const effectiveDurationSeconds = Math.max(
		durationSeconds,
		visibleDurationSeconds,
	);
	const fps =
		useEditor((e) => e.project.getActiveOrNull()?.settings.fps) ?? DEFAULT_FPS;
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({
		zoomLevel,
		fps,
	});
	const tickCount =
		Math.ceil(effectiveDurationSeconds / tickIntervalSeconds) + 1;

	const { scrollLeft, viewportWidth } = useScrollPosition({
		scrollRef: tracksScrollRef,
	});

	// Keep extra buffer because zoom layout and scroll position can briefly
	// settle on different frames.
	const bufferPx = Math.max(200, viewportWidth * 0.25);

	const visibleStartTimeSeconds = Math.max(
		0,
		(scrollLeft - bufferPx) / pixelsPerSecond,
	);
	const visibleEndTimeSeconds =
		(scrollLeft + viewportWidth + bufferPx) / pixelsPerSecond;

	const startTickIndex = Math.max(
		0,
		Math.floor(visibleStartTimeSeconds / tickIntervalSeconds),
	);
	const endTickIndex = Math.min(
		tickCount - 1,
		Math.ceil(visibleEndTimeSeconds / tickIntervalSeconds),
	);

	const timelineTicks: Array<JSX.Element> = [];
	for (
		let tickIndex = startTickIndex;
		tickIndex <= endTickIndex;
		tickIndex += 1
	) {
		const timeSeconds = tickIndex * tickIntervalSeconds;
		if (timeSeconds > effectiveDurationSeconds) break;

		const timeTicks = Math.round(timeSeconds * TICKS_PER_SECOND);
		const showLabel = shouldShowLabel({
			time: timeSeconds,
			labelIntervalSeconds,
		});
		timelineTicks.push(
			<TimelineTick
				key={tickIndex}
				time={timeTicks}
				timeInSeconds={timeSeconds}
				zoomLevel={zoomLevel}
				fps={fps}
				showLabel={showLabel}
			/>,
		);
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="slider"
					tabIndex={0}
					aria-label={t("timeline.ruler")}
					aria-valuemin={0}
					aria-valuemax={effectiveDurationSeconds}
					aria-valuenow={0}
					className="relative flex-1 overflow-x-visible"
					style={{ height: TIMELINE_RULER_HEIGHT_PX }}
					onWheel={handleWheel}
					onClick={(event) => {
						// Ruler seek already happens on pointerdown via playhead scrubbing.
						// Forwarding the follow-up click re-enters the selection-clearing path.
						if (event.target === event.currentTarget) {
							handleTimelineContentClick(event);
						}
					}}
					onPointerDown={handleRulerTrackingPointerDown}
					onContextMenu={(event) => {
						menuTime.current = timeAtClientX({ clientX: event.clientX, element: event.currentTarget, zoomLevel });
					}}
					onKeyDown={() => {}}
				>
					<div
						role="none"
						ref={rulerRef}
						className="relative cursor-default touch-none select-none"
						style={{
							height: TIMELINE_RULER_HEIGHT_PX,
							width: `${dynamicTimelineWidth}px`,
						}}
						onPointerDown={handleRulerPointerDown}
					>
						{timelineTicks}
					</div>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent
				className="w-48"
				onCloseAutoFocus={(event) => {
					// The note the request opened keeps the focus.
					if (askedAgent.current) event.preventDefault();
					askedAgent.current = false;
				}}
			>
				<ContextMenuItem
					icon={<HugeiconsIcon icon={AiSearchIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						askedAgent.current = true;
						requestAgentCheck({ editor, time: menuTime.current, note: t("bookmark.agentCheckNote") });
					}}
				>
					{t("timeline.askAgentCheck")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
