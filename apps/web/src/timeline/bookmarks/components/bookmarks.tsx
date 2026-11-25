"use client";

import { useI18n } from "@/i18n/provider";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import type { BookmarkDragState } from "../hooks/use-bookmark-drag";
import { areaTarget, startBookmarkArea, useBookmarkArea } from "../area-state";
import { DEFAULT_TIMELINE_BOOKMARK_COLOR } from "@/timeline/components/theme";
import { TIMELINE_BOOKMARK_ROW_HEIGHT_PX } from "@/timeline/components/layout";
import { DEFAULT_FPS } from "@/fps/defaults";
import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { generateUUID } from "@/utils/id";
import type { Bookmark } from "@/timeline";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { uppercase } from "@/utils/string";
import { clamp, formatNumberForDisplay } from "@/utils/math";
import { timelineTimeToPixels, timelineTimeToSnappedPixels } from "@/timeline";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	snapSeekMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

const MIN_BOOKMARK_WIDTH_PX = 2;
const BOOKMARK_MARKER_WIDTH_PX = 12;
const BOOKMARK_MARKER_HEIGHT_PX = 15;
const BOOKMARK_HALF_WIDTH_PX = BOOKMARK_MARKER_WIDTH_PX / 2;
const BOOKMARK_MARKER_CLIP_PATH =
	"polygon(50% 100%, 12% 72%, 12% 10%, 88% 10%, 88% 72%)";

function seekToBookmarkTime({
	editor,
	time,
}: {
	editor: EditorCore;
	time: MediaTime;
}) {
	const activeProject = editor.project.getActive();
	const duration = editor.timeline.getTotalDuration();
	const rate = activeProject?.settings.fps ?? DEFAULT_FPS;
	const snappedTime = snapSeekMediaTime({ time, duration, fps: rate });
	editor.playback.seek({ time: snappedTime });
}

interface TimelineBookmarksRowProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	dragState: BookmarkDragState;
	onBookmarkMouseDown: (params: {
		event: React.MouseEvent;
		bookmark: Bookmark;
	}) => void;
	handleWheel: (event: React.WheelEvent) => void;
	handleTimelineContentClick: (event: React.MouseEvent) => void;
	handleRulerTrackingPointerDown: (event: React.PointerEvent) => void;
	handleRulerPointerDown: (event: React.PointerEvent) => void;
}

export function TimelineBookmarksRow({
	zoomLevel,
	dynamicTimelineWidth,
	dragState,
	onBookmarkMouseDown,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingPointerDown,
	handleRulerPointerDown,
}: TimelineBookmarksRowProps) {
	const { t } = useI18n();
	const scene = useEditor((e) => e.scenes.getActiveScene());
	const promotedKeys = useRef(new Map<string, string>());

	return (
		<div
			className="relative flex-1 overflow-hidden"
			style={{ height: TIMELINE_BOOKMARK_ROW_HEIGHT_PX }}
		>
			<button
				className="relative w-full cursor-default touch-none select-none border-0 bg-transparent p-0"
				style={{
					height: TIMELINE_BOOKMARK_ROW_HEIGHT_PX,
					width: `${dynamicTimelineWidth}px`,
				}}
				aria-label={t("timeline.ruler")}
				type="button"
				onWheel={handleWheel}
				onClick={(event) => {
					if (!event.currentTarget.contains(event.target as Node)) return;
					handleTimelineContentClick(event);
				}}
				onPointerDown={(event) => {
					if (!event.currentTarget.contains(event.target as Node)) return;
					handleRulerPointerDown(event);
					handleRulerTrackingPointerDown(event);
				}}
			>
				{scene.bookmarks.map((bookmark, index) => {
					const key = bookmark.id
						? promotedKeys.current.get(bookmark.id) ?? bookmark.id
						: `bookmark-${bookmark.time}-${index}`;
					return (
						<TimelineBookmark
							key={`${scene.id}:${key}`}
							bookmark={bookmark}
							zoomLevel={zoomLevel}
							dragState={dragState}
							onBookmarkMouseDown={onBookmarkMouseDown}
							onAssignId={(id) => promotedKeys.current.set(id, key)}
						/>
					);
				})}
			</button>
		</div>
	);
}

function TimelineBookmark({
	bookmark,
	zoomLevel,
	dragState,
	onBookmarkMouseDown,
	onAssignId,
}: {
	bookmark: Bookmark;
	zoomLevel: number;
	dragState: BookmarkDragState;
	onAssignId: (id: string) => void;
	onBookmarkMouseDown: (params: {
		event: React.MouseEvent;
		bookmark: Bookmark;
	}) => void;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const [isPopoverOpen, setIsPopoverOpen] = useState(false);
	const [hovered, setHovered] = useState(false);
	useEffect(() => {
		if ((!hovered && !isPopoverOpen) || !bookmark.box) return;
		const shown = { ...areaTarget(editor, bookmark.time), bookmark };
		const field = isPopoverOpen ? "shown" : "hovered";
		useBookmarkArea.setState({ [field]: shown });
		return () => {
			if (useBookmarkArea.getState()[field] === shown) useBookmarkArea.setState({ [field]: null });
		};
	}, [editor, hovered, isPopoverOpen, bookmark]);

	const isDragging = dragState.isDragging && dragState.bookmark === bookmark;

	const displayTime = isDragging ? dragState.currentTime : bookmark.time;
	const time = bookmark.time;
	const bookmarkDuration = bookmark.duration ?? ZERO_MEDIA_TIME;
	const durationWidth =
		bookmarkDuration > 0
			? timelineTimeToPixels({ time: bookmarkDuration, zoomLevel })
			: 0;
	const hasDurationRange = durationWidth > MIN_BOOKMARK_WIDTH_PX;
	const bookmarkWidth = BOOKMARK_MARKER_WIDTH_PX + Math.max(durationWidth, 0);
	const left = timelineTimeToSnappedPixels({ time: displayTime, zoomLevel });
	const bookmarkLeft = left - BOOKMARK_HALF_WIDTH_PX;
	const rightHalfLeft = BOOKMARK_HALF_WIDTH_PX + Math.max(durationWidth, 0);
	const iconColor = bookmark.resolved ? "#888888" : bookmark.color ?? (bookmark.author === "agent" ? "#e88b35" : DEFAULT_TIMELINE_BOOKMARK_COLOR);

	const handleSeek = () => seekToBookmarkTime({ editor, time });

	const handleClick = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.detail === 2) {
			setIsPopoverOpen(true);
		} else {
			handleSeek();
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		handleSeek();
	};

	const handleMouseDown = (event: React.MouseEvent) => {
		onBookmarkMouseDown({ event, bookmark });
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
			<PopoverAnchor asChild>
				<button
					className="absolute top-0 h-full min-w-0.5 border-0 bg-transparent p-0"
					style={{
						left: `${bookmarkLeft}px`,
						width: `${bookmarkWidth}px`,
					}}
					aria-label={t(bookmark.author === "agent" ? "bookmark.agentNote" : "bookmark.bookmarkAt", {
						time: formatNumberForDisplay({ value: mediaTimeToSeconds({ time }), fractionDigits: 1 }),
					})}
					type="button"
					onPointerEnter={() => setHovered(true)}
					onPointerLeave={() => setHovered(false)}
					onFocus={() => setHovered(true)}
					onBlur={() => setHovered(false)}
					onPointerDown={(event) => event.stopPropagation()}
					onMouseDown={handleMouseDown}
					onClick={handleClick}
					onKeyDown={handleKeyDown}
				>
					{hasDurationRange ? (
						<div
							className="absolute opacity-30"
							style={{
								top: 1.5,
								height: BOOKMARK_MARKER_HEIGHT_PX - 2.5,
								left: BOOKMARK_HALF_WIDTH_PX,
								width: durationWidth,
								backgroundColor: iconColor,
							}}
						/>
					) : null}
					<div
						className="absolute top-0 overflow-hidden"
						style={{
							left: 0,
							width: BOOKMARK_HALF_WIDTH_PX,
							height: BOOKMARK_MARKER_HEIGHT_PX,
						}}
					>
						<div
							className="absolute inset-0"
							style={{
								width: BOOKMARK_MARKER_WIDTH_PX,
								height: BOOKMARK_MARKER_HEIGHT_PX,
								clipPath: BOOKMARK_MARKER_CLIP_PATH,
								backgroundColor: "hsl(var(--background))",
							}}
						/>
						<div
							className="absolute"
							style={{
								top: 1,
								left: 1,
								width: BOOKMARK_MARKER_WIDTH_PX - 2,
								height: BOOKMARK_MARKER_HEIGHT_PX - 2,
								clipPath: BOOKMARK_MARKER_CLIP_PATH,
								backgroundColor: iconColor,
							}}
						/>
					</div>
					<div
						className="absolute top-0 overflow-hidden"
						style={{
							left: rightHalfLeft,
							width: BOOKMARK_HALF_WIDTH_PX,
							height: BOOKMARK_MARKER_HEIGHT_PX,
						}}
					>
						<div
							className="absolute top-0"
							style={{
								left: -BOOKMARK_HALF_WIDTH_PX,
								width: BOOKMARK_MARKER_WIDTH_PX,
								height: BOOKMARK_MARKER_HEIGHT_PX,
								clipPath: BOOKMARK_MARKER_CLIP_PATH,
								backgroundColor: "hsl(var(--background))",
							}}
						/>
						<div
							className="absolute"
							style={{
								top: 1,
								left: 1 - BOOKMARK_HALF_WIDTH_PX,
								width: BOOKMARK_MARKER_WIDTH_PX - 2,
								height: BOOKMARK_MARKER_HEIGHT_PX - 2,
								clipPath: BOOKMARK_MARKER_CLIP_PATH,
								backgroundColor: iconColor,
							}}
						/>
					</div>
				</button>
			</PopoverAnchor>
			<PopoverContent
				className="w-64 flex flex-col gap-3 p-3"
				align="start"
				side="bottom"
				sideOffset={8}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					if (bookmark.box) {
						editor.playback.pause();
						handleSeek();
					}
				}}
			>
				<BookmarkPopoverContent
					bookmark={bookmark}
					time={time}
					timelineDuration={duration}
					onPopoverClose={() => setIsPopoverOpen(false)}
					onAssignId={onAssignId}
				/>
			</PopoverContent>
		</Popover>
	);
}

function BookmarkPopoverContent({
	bookmark,
	time,
	timelineDuration,
	onPopoverClose,
	onAssignId,
}: {
	bookmark: Bookmark;
	time: MediaTime;
	timelineDuration: MediaTime;
	onPopoverClose: () => void;
	onAssignId: (id: string) => void;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const sceneId = editor.scenes.getActiveScene().id;
	const session = editor.project.getSession();
	const [draftNote, setDraftNote] = useState<string | null>(null);
	const pendingNote = useRef<string | null>(null);
	useSyncExternalStore(editor.voiceOver.subscribe, editor.voiceOver.getSnapshot, editor.voiceOver.getServerSnapshot);
	const committedColor = (bookmark.color ?? DEFAULT_TIMELINE_BOOKMARK_COLOR)
		.replace("#", "")
		.toUpperCase();
	const [draftColorHex, setDraftColorHex] = useState(
		committedColor,
	);

	useEffect(() => {
		setDraftColorHex(committedColor);
	}, [committedColor]);

	const handleRemove = () => {
		editor.scenes.removeBookmark({ time, bookmark });
		onPopoverClose();
	};

	const handleUpdate = ({
		note,
		color,
		duration,
	}: Partial<Omit<Bookmark, "time">>) => {
		const updates: Partial<Omit<Bookmark, "time">> = {};
		if (note !== undefined && note !== bookmark.note) {
			updates.note = note;
			if (!bookmark.id) {
				updates.id = generateUUID();
				onAssignId(updates.id);
				updates.author = "user";
				updates.createdAt = new Date().toISOString();
				updates.resolved = false;
			}
		}
		if (
			color !== undefined &&
			color.toUpperCase() !== (bookmark.color ?? "").toUpperCase()
		) {
			updates.color = color;
		}
		if (duration !== undefined && duration !== bookmark.duration) {
			updates.duration = duration;
		}
		if (Object.keys(updates).length === 0) return;
		editor.scenes.updateBookmark({ time, bookmark, updates });
	};
	const commitNote = useCommittedRef(() => {
		const note = pendingNote.current;
		pendingNote.current = null;
		if (note !== null && editor.project.getSession() === session &&
			editor.scenes.getActiveSceneOrNull()?.id === sceneId) {
			handleUpdate({ note });
		}
	});
	useEffect(() => () => commitNote.current(), [commitNote]);
	const maxDuration = mediaTimeToSeconds({
		time:
			timelineDuration > time
				? subMediaTime({ a: timelineDuration, b: time })
				: ZERO_MEDIA_TIME,
	});
	const durationSeconds = mediaTimeToSeconds({
		time: bookmark.duration ?? ZERO_MEDIA_TIME,
	});

	return (
		<>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">{t("bookmark.note")}</Label>
				<Input
					placeholder={t("bookmark.addNote")}
					value={draftNote ?? bookmark.note ?? ""}
					onChange={(event) => {
						pendingNote.current = event.currentTarget.value;
						setDraftNote(pendingNote.current);
					}}
					onBlur={() => {
						commitNote.current();
						setDraftNote(null);
					}}
					className="h-8 text-sm"
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">{t("common.color")}</Label>
				<div className="relative">
					<ColorPicker
						beginDragGesture={editor.timeline.beginPreviewGesture}
						onDragCancel={(color) => setDraftColorHex(uppercase({ string: color }))}
						value={uppercase({ string: draftColorHex })}
						onChange={(color) => setDraftColorHex(uppercase({ string: color }))}
						onChangeEnd={(color) =>
							handleUpdate({ color: `#${uppercase({ string: color })}` })
						}
						className="bg-background border"
					/>
					{bookmark.color &&
						bookmark.color.replace(/^#/, "").toUpperCase() !==
							DEFAULT_TIMELINE_BOOKMARK_COLOR.replace(
								/^#/,
								"",
							).toUpperCase() && (
							<Button
								type="button"
								variant="text"
								size="text"
								aria-label={t("bookmark.resetColor")}
								className="absolute top-1/2 right-1 -translate-y-1/2 mr-1"
								onClick={() =>
									editor.scenes.updateBookmark({
										time,
										bookmark,
										updates: { color: undefined },
									})
								}
							>
								<HugeiconsIcon
									icon={ArrowTurnBackwardIcon}
									className="!size-3.5"
								/>
							</Button>
						)}
				</div>
			</div>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">{t("common.duration")}</Label>
				<div className="flex items-center gap-1.5">
					<Input
						type="number"
						min={0}
						step={0.1}
						value={durationSeconds}
						onChange={(event) => {
							const parsed = parseFloat(event.target.value);
							const value = Number.isNaN(parsed)
								? 0
								: clamp({
										value: parsed,
										min: 0,
										max: maxDuration,
									});
							handleUpdate({
								duration: mediaTimeFromSeconds({ seconds: value }),
							});
						}}
						className="h-8 text-sm"
						containerClassName="w-full"
					/>
				</div>
			</div>
			{bookmark.replies?.map((reply) => <div key={reply.id} className="text-xs"><strong>{t("bookmark.author", { author: t(reply.author === "agent" ? "bookmark.agent" : "bookmark.user") })}</strong> {reply.text}</div>)}
			{bookmark.note && <Button type="button" variant="outline" size="sm" onClick={() => editor.scenes.updateBookmark({ time, bookmark, updates: { resolved: !bookmark.resolved } })}>{bookmark.resolved ? t("bookmark.reopen") : t("bookmark.resolve")}</Button>}
			{bookmark.author === "agent" && <span className="text-xs">{t("bookmark.agent")}</span>}
			<Button type="button" variant="outline" size="sm" disabled={editor.voiceOver.isCapturing()} onClick={() => {
				onPopoverClose();
				startBookmarkArea(editor, time, bookmark);
			}}>{t("bookmark.pointArea")}</Button>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="text-destructive hover:bg-destructive/10"
				onClick={handleRemove}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						handleRemove();
					}
				}}
				aria-label={t("bookmark.delete")}
			>
				<HugeiconsIcon icon={Delete02Icon} className="!size-3.5" />
				{t("common.delete")}
			</Button>
		</>
	);
}
