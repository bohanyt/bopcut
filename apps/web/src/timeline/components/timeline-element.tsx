"use client";

import { useI18n } from "@/i18n/provider";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useEditor } from "@/editor/use-editor";
import { useVisibleThumbnail } from "@/media/use-visible-thumbnail";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { AudioWaveform, WAVEFORM_GAIN_SAMPLE_COUNT } from "./audio-waveform";
import { AudioVolumeLine } from "./audio-volume-line";
import {
	useKeyframeDrag,
	type KeyframeDragState,
} from "@/timeline/hooks/element/use-keyframe-drag";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { useKeyframeBoxSelect } from "@/timeline/hooks/element/use-keyframe-box-select";
import { SelectionBox } from "@/selection/selection-box";
import { getElementKeyframes } from "@/animation";
import { fitPresetSpans, readPresetSettings } from "@/animation/presets";
import {
	canElementHaveAudio,
	canElementBeHidden,
	hasElementEffects,
	hasMediaId,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { getTrackHeight } from "./track-layout";
import {
	getTimelineElementClassName,
	TIMELINE_COMPOUND_THEME,
	TIMELINE_TRACK_THEME,
} from "./theme";
import { isCompoundElement } from "@/timeline/compound";
import { rendererDevice } from "@/services/renderer/renderer-device";
import {
	COMPOUND_THUMBNAIL_COUNT,
	getCompoundThumbnailCache,
	getCompoundThumbnailKey,
	renderCompoundThumbnails,
} from "@/timeline/compound-thumbnails";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SelectionBoxBounds } from "@/selection/types";
import type {
	TimelineElement as TimelineElementType,
	TimelineTrack,
	VideoElement,
	ImageElement,
	AudioElement,
	CompoundElement,
} from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import type { MediaAsset } from "@/media/types";
import {
	canToggleSourceAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { buildWaveformGainSamples, isElementMuted } from "@/timeline/audio-state";
import { getTimelinePixelsPerSecond } from "@/timeline";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	getActionDefinition,
	type TAction,
	type TActionWithOptionalArgs,
	invokeAction,
} from "@/actions";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { resolveStickerId } from "@/stickers";
import { buildGraphicPreviewUrl } from "@/graphics";
import Image from "next/image";
import {
	ScissorIcon,
	Delete02Icon,
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
	VolumeMute02Icon,
	Search01Icon,
	Exchange01Icon,
	KeyframeIcon,
	MagicWand05Icon,
	Layers01Icon,
	LayerAddIcon,
	Unlink01Icon,
	FolderOpenIcon,
	AiSearchIcon,
	LayoutTwoRowIcon,
	FaceIdIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { uppercase } from "@/utils/string";
import { useMemo, type ComponentProps, type ReactNode } from "react";
import { requestAgentCheck } from "@/timeline/bookmarks/agent-check";
import { useSplitLayoutRequest } from "@/reframe/components/split-layout-dialog";
import { useFacePick } from "@/reframe/components/face-pick";
import { canFollowFace } from "@/reframe/apply-face-follow";
import type { SelectedKeyframeRef, ElementKeyframe } from "@/animation/types";
import { cn } from "@/utils/ui";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";
import {
	getExpandedRows,
	getExpansionHeight,
	type ExpandedRow,
} from "./expanded-layout";

const KEYFRAME_INDICATOR_MIN_WIDTH_PX = 40;
const ELEMENT_RING_WIDTH_PX = 1.5;

const PixelsPerSecondContext = createContext<number | null>(null);
const ClipLeftContext = createContext(0);
const THUMBNAIL_ASPECT_RATIO = 16 / 9;
const mediaIndexes = new WeakMap<
	readonly MediaAsset[],
	Map<string, MediaAsset>
>();

function useTimelineMediaAsset(id: string | null) {
	const { media } = useEditor();
	const subscribe = useCallback(
		(listener: () => void) => media.subscribe(listener),
		[media],
	);
	const getSnapshot = useCallback(() => {
		if (id === null) return undefined;
		const assets = media.getAssets();
		let index = mediaIndexes.get(assets);
		if (!index) {
			index = new Map(assets.map((asset) => [asset.id, asset]));
			mediaIndexes.set(assets, index);
		}
		return index.get(id);
	}, [id, media]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface KeyframeIndicator {
	time: MediaTime;
	offsetPx: number;
	keyframes: SelectedKeyframeRef[];
}

export function buildKeyframeIndicator({
	keyframe,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
}: {
	keyframe: ElementKeyframe;
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
}): {
	time: MediaTime;
	offsetPx: number;
	keyframeRef: SelectedKeyframeRef;
} {
	const keyframeRef = {
		trackId,
		elementId,
		propertyPath: keyframe.propertyPath,
		keyframeId: keyframe.id,
	};
	const keyframeLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime + keyframe.time,
		zoomLevel,
	});
	return {
		time: keyframe.time,
		offsetPx: keyframeLeft - elementLeft,
		keyframeRef,
	};
}

export function getKeyframeIndicators({
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	elementWidth,
}: {
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	elementWidth: number;
}): KeyframeIndicator[] {
	if (elementWidth < KEYFRAME_INDICATOR_MIN_WIDTH_PX) {
		return [];
	}

	const keyframesByTime = new Map<MediaTime, KeyframeIndicator>();
	for (const keyframe of keyframes) {
		const indicator = buildKeyframeIndicator({
			keyframe,
			trackId,
			elementId,
			displayedStartTime,
			zoomLevel,
			elementLeft,
		});
		const existingIndicator = keyframesByTime.get(indicator.time);
		if (!existingIndicator) {
			keyframesByTime.set(indicator.time, {
				time: indicator.time,
				offsetPx: indicator.offsetPx,
				keyframes: [indicator.keyframeRef],
			});
			continue;
		}

		existingIndicator.keyframes.push(indicator.keyframeRef);
	}

	return [...keyframesByTime.values()].sort((a, b) => a.time - b.time);
}

export function getDisplayShortcut({ action }: { action: TAction }) {
	const defaultShortcuts = getActionDefinition({ action }).defaultShortcuts;
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

type ClipTrack = Pick<TimelineTrack, "id" | "type">;

interface TimelineElementProps {
	element: TimelineElementType;
	displayElement: TimelineElementType;
	track: ClipTrack;
	zoomLevel: number;
	isSelected: boolean;
	isExpanded: boolean;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onFocusChange: (id: string | null) => void;
	onMenuChange: (id: string, open: boolean) => void;
	draggedStartTime?: MediaTime;
	dragOffsetY: number;
	isDropTarget?: boolean;
}

export const TimelineElement = memo(function TimelineElement({
	element,
	displayElement,
	track,
	zoomLevel,
	isSelected,
	isExpanded,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onFocusChange,
	onMenuChange,
	draggedStartTime,
	dragOffsetY,
	isDropTarget = false,
}: TimelineElementProps) {
	const { t } = useI18n();
	// The note a check request opens keeps the focus when the menu closes.
	const askedAgent = useRef(false);
	const displayedStartTime = draggedStartTime ?? displayElement.startTime;
	const elementWidth = timelineTimeToPixels({
		time: displayElement.duration,
		zoomLevel,
	});
	const timelinePixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const elementLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime,
		zoomLevel,
	});
	const baseTrackHeight = getTrackHeight({ type: track.type });
	const elementKeyframes = useMemo(
		() => getElementKeyframes({ animations: displayElement.animations }),
		[displayElement.animations],
	);

	const renderContent = (
		expandedContent: ReactNode,
		expansionHeight: number,
		indicators?: ReactNode,
	) => (
		<div
			className="absolute top-0 select-none"
			data-timeline-element-id={element.id}
			title={
				element.groupId
					? t("timeline.group", { id: element.groupId })
					: undefined
			}
			style={{
				left: `${elementLeft}px`,
				width: `${elementWidth}px`,
				height:
					expansionHeight > 0
						? `${baseTrackHeight + expansionHeight}px`
						: "100%",
				transform:
					draggedStartTime !== undefined
						? `translate3d(0, ${dragOffsetY}px, 0)`
						: undefined,
			}}
			onFocus={() => onFocusChange(element.id)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					onFocusChange(null);
			}}
		>
			{element.groupId && (
				<span
					className="pointer-events-none absolute right-1 top-0 z-10 text-xs"
					title={t("timeline.group", { id: element.groupId })}
				>
					?
				</span>
			)}
			{isSelected && element.humanFields?.length ? (
				<span
					className="pointer-events-none absolute right-1 bottom-1 z-10 size-1.5 rounded-full bg-primary"
					title={t("timeline.humanFieldsProtected")}
					aria-label={t("timeline.humanFieldsProtected")}
					role="img"
				/>
			) : null}
			<ElementInner
				element={element}
				displayElement={displayElement}
				track={track}
				isSelected={isSelected}
				isExpanded={expansionHeight > 0}
				baseTrackHeight={baseTrackHeight}
				expandedContent={expandedContent}
				onElementClick={onElementClick}
				onElementMouseDown={onElementMouseDown}
				onResizeStart={onResizeStart}
				isDropTarget={isDropTarget}
			/>
			{indicators}
		</div>
	);

	return (
		<PixelsPerSecondContext.Provider value={timelinePixelsPerSecond}>
			<ClipLeftContext.Provider value={elementLeft}>
				<ContextMenu onOpenChange={(open) => onMenuChange(element.id, open)}>
					{elementKeyframes.length > 0 ? (
						<TimelineElementKeyframes
							element={element}
							animations={displayElement.animations}
							elementKeyframes={elementKeyframes}
							trackId={track.id}
							zoomLevel={zoomLevel}
							displayedStartTime={displayedStartTime}
							elementLeft={elementLeft}
							elementWidth={elementWidth}
							baseTrackHeight={baseTrackHeight}
							isExpanded={isExpanded}
							isSelected={isSelected}
							renderContent={renderContent}
						/>
					) : (
						<ContextMenuTrigger asChild>
							{renderContent(null, 0)}
						</ContextMenuTrigger>
					)}
					<ContextMenuContent
						className="w-64"
						onCloseAutoFocus={(event) => {
							if (askedAgent.current) event.preventDefault();
							askedAgent.current = false;
						}}
					>
						<TimelineElementMenu
							element={element}
							track={track}
							hasKeyframes={elementKeyframes.length > 0}
							isExpanded={isExpanded}
							onAskAgent={() => { askedAgent.current = true; }}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</ClipLeftContext.Provider>
		</PixelsPerSecondContext.Provider>
	);
});

function TimelineElementKeyframes({
	element,
	animations,
	elementKeyframes,
	trackId,
	zoomLevel,
	displayedStartTime,
	elementLeft,
	elementWidth,
	baseTrackHeight,
	isExpanded,
	isSelected,
	renderContent,
}: {
	element: TimelineElementType;
	/** The keys as shown now (a trim being dragged keeps them on the footage). */
	animations: TimelineElementType["animations"];
	elementKeyframes: ElementKeyframe[];
	trackId: string;
	zoomLevel: number;
	displayedStartTime: MediaTime;
	elementLeft: number;
	elementWidth: number;
	baseTrackHeight: number;
	isExpanded: boolean;
	isSelected: boolean;
	renderContent: (
		expandedContent: ReactNode,
		expansionHeight: number,
		indicators: ReactNode,
	) => React.ReactElement;
}) {
	const keyframeIndicators = isSelected
		? getKeyframeIndicators({
				keyframes: elementKeyframes,
				trackId: trackId,
				elementId: element.id,
				displayedStartTime,
				zoomLevel,
				elementLeft,
				elementWidth,
			})
		: [];

	const {
		keyframeDragState,
		handleKeyframeMouseDown,
		handleKeyframeClick,
		getVisualOffsetPx,
	} = useKeyframeDrag({ zoomLevel, element, displayedStartTime });

	const expandedRows = useMemo(
		() =>
			isExpanded ? getExpandedRows({ animations }) : [],
		[isExpanded, animations],
	);

	const {
		containerRef: expandedLanesRef,
		selectionBox: keyframeSelectionBox,
		isBoxSelecting: isKeyframeBoxSelecting,
		handleExpandedAreaMouseDown,
		handleExpandedAreaClick,
	} = useKeyframeBoxSelect({
		trackId: trackId,
		elementId: element.id,
		rows: expandedRows,
		keyframes: elementKeyframes,
		displayedStartTime,
		zoomLevel,
		elementLeft,
	});

	const expandedContent =
		isExpanded && expandedRows.length > 0 ? (
			<ExpandedKeyframeLanes
				rows={expandedRows}
				keyframes={elementKeyframes}
				trackId={trackId}
				elementId={element.id}
				displayedStartTime={displayedStartTime}
				zoomLevel={zoomLevel}
				elementLeft={elementLeft}
				keyframeDragState={keyframeDragState}
				onKeyframeMouseDown={handleKeyframeMouseDown}
				onKeyframeClick={handleKeyframeClick}
				getVisualOffsetPx={getVisualOffsetPx}
				containerRef={expandedLanesRef}
				onLaneMouseDown={handleExpandedAreaMouseDown}
				onLaneClick={handleExpandedAreaClick}
				selectionBox={keyframeSelectionBox}
				isBoxSelecting={isKeyframeBoxSelecting}
			/>
		) : null;

	const indicators = isSelected ? (
		<div
			className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
			style={{ height: `${baseTrackHeight}px` }}
		>
			<KeyframeIndicators
				indicators={keyframeIndicators}
				dragState={keyframeDragState}
				displayedStartTime={displayedStartTime}
				elementLeft={elementLeft}
				onKeyframeMouseDown={handleKeyframeMouseDown}
				onKeyframeClick={handleKeyframeClick}
				getVisualOffsetPx={getVisualOffsetPx}
			/>
		</div>
	) : null;

	return (
		<ContextMenuTrigger asChild>
			{renderContent(
				expandedContent,
				getExpansionHeight({ rows: expandedRows }),
				indicators,
			)}
		</ContextMenuTrigger>
	);
}

function TimelineElementMenu({
	element,
	track,
	hasKeyframes,
	isExpanded,
	onAskAgent,
}: {
	element: TimelineElementType;
	track: ClipTrack;
	hasKeyframes: boolean;
	isExpanded: boolean;
	onAskAgent: () => void;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const mediaId = hasMediaId(element) ? element.mediaId : null;
	const mediaAsset = useTimelineMediaAsset(mediaId) ?? null;
	const { selectedElements, isElementSelected } = useElementSelection();
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const toggleElementExpanded = useTimelineStore(
		(s) => s.toggleElementExpanded,
	);
	const hasAudio = mediaSupportsAudio({ media: mediaAsset });
	const isCurrentElementSelected = isElementSelected({
		trackId: track.id,
		elementId: element.id,
	});
	const isMuted = canElementHaveAudio(element) && isElementMuted({ element });
	const canToggleCurrentSourceAudio =
		selectedElements.length === 1 &&
		isCurrentElementSelected &&
		canToggleSourceAudio(element, mediaAsset);
	const isElementSourceAudioSeparated =
		element.type === "video" && isSourceAudioSeparated({ element });

	const handleRevealInMedia = ({ event }: { event: React.MouseEvent }) => {
		event.stopPropagation();
		if (mediaId !== null) requestRevealMedia(mediaId);
	};

	return (
		<>
			{isCompoundElement(element) && (
				<>
					<ContextMenuItem
						icon={<HugeiconsIcon icon={FolderOpenIcon} />}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							void editor.scenes.enterCompound({
								trackId: track.id,
								elementId: element.id,
							});
						}}
					>
						{t("timeline.openCompound")}
					</ContextMenuItem>
					{selectedElements.length === 1 && (
						<ActionMenuItem
							action="break-apart-compound"
							icon={<HugeiconsIcon icon={Unlink01Icon} />}
						>
							{t("timeline.breakApart")}
						</ActionMenuItem>
					)}
					<ContextMenuSeparator />
				</>
			)}
			<ActionMenuItem
				action="split-selected"
				icon={<HugeiconsIcon icon={ScissorIcon} />}
			>
				{t("timeline.split")}
			</ActionMenuItem>
			<CopyMenuItem />
			{selectedElements.length === 1 && (
				<ActionMenuItem
					action="duplicate-selected"
					icon={<HugeiconsIcon icon={Copy01Icon} />}
				>
					{t("common.duplicate")}
				</ActionMenuItem>
			)}
			{isCurrentElementSelected && (
				<ActionMenuItem
					action="create-compound"
					icon={<HugeiconsIcon icon={LayerAddIcon} />}
				>
					{t("timeline.createCompound")}
				</ActionMenuItem>
			)}
			{canElementHaveAudio(element) && hasAudio && (
				<MuteMenuItem
					isMultipleSelected={selectedElements.length > 1}
					isCurrentElementSelected={isCurrentElementSelected}
					isMuted={isMuted}
				/>
			)}
			{canToggleCurrentSourceAudio && (
				<ContextMenuItem
					icon={
						<HugeiconsIcon
							icon={isElementSourceAudioSeparated ? ScissorIcon : ScissorIcon}
						/>
					}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						invokeAction("toggle-source-audio");
					}}
				>
					{t(
						isElementSourceAudioSeparated
							? "timeline.recoverAudio"
							: "timeline.extractAudio",
					)}
				</ContextMenuItem>
			)}
			{canElementBeHidden(element) && (
				<VisibilityMenuItem
					element={element}
					isMultipleSelected={selectedElements.length > 1}
					isCurrentElementSelected={isCurrentElementSelected}
				/>
			)}
			{hasKeyframes && (
				<ContextMenuItem
					icon={<HugeiconsIcon icon={KeyframeIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						toggleElementExpanded(element.id);
					}}
				>
					{isExpanded
						? t("timeline.collapseKeyframes")
						: t("timeline.expandKeyframes")}
				</ContextMenuItem>
			)}
			{selectedElements.length === 1 && hasMediaId(element) && (
				<>
					<ContextMenuItem
						icon={<HugeiconsIcon icon={Search01Icon} />}
						onClick={(event: React.MouseEvent) =>
							handleRevealInMedia({ event })
						}
					>
						{t("timeline.revealMedia")}
					</ContextMenuItem>
					<ContextMenuItem
						icon={<HugeiconsIcon icon={Exchange01Icon} />}
						disabled
					>
						{t("timeline.replaceMedia")}
					</ContextMenuItem>
				</>
			)}
			{element.humanFields?.length ? (
				<ContextMenuItem onClick={(event) => {
					event.stopPropagation();
					editor.timeline.updateElements({
						updates: [{ trackId: track.id, elementId: element.id, patch: { humanFields: undefined } }],
					});
				}}>
					{t("timeline.releaseHumanFields")}
				</ContextMenuItem>
			) : null}
			{element.type === "video" && (
				<ContextMenuItem
					icon={<HugeiconsIcon icon={LayoutTwoRowIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						useSplitLayoutRequest.setState({ clip: { trackId: track.id, elementId: element.id } });
					}}
				>
					{t("reframe.menu")}
				</ContextMenuItem>
			)}
			{canFollowFace(element) && (
				<ContextMenuItem
					icon={<HugeiconsIcon icon={FaceIdIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						// The click goes to the frame on screen.
						editor.playback.pause();
						useFacePick.setState({ clip: { trackId: track.id, elementId: element.id } });
					}}
				>
					{t("reframe.followMenu")}
				</ContextMenuItem>
			)}
			<ContextMenuItem
				icon={<HugeiconsIcon icon={AiSearchIcon} />}
				onClick={(event: React.MouseEvent) => {
					event.stopPropagation();
					onAskAgent();
					requestAgentCheck({
						editor,
						time: element.startTime,
						duration: element.duration,
						elementIds: [element.id],
						note: t("bookmark.agentCheckNote"),
					});
				}}
			>
				{t("timeline.askAgentCheck")}
			</ContextMenuItem>

			<ContextMenuSeparator />
			<DeleteMenuItem
				isMultipleSelected={selectedElements.length > 1}
				isCurrentElementSelected={isCurrentElementSelected}
				elementType={element.type}
				selectedCount={selectedElements.length}
			/>
		</>
	);
}

function ElementInner({
	element,
	displayElement,
	track,
	isSelected,
	isExpanded,
	baseTrackHeight,
	expandedContent,
	onElementClick,
	onElementMouseDown,
	onResizeStart,
	isDropTarget = false,
}: {
	element: TimelineElementType;
	displayElement?: TimelineElementType;
	track: ClipTrack;
	isSelected: boolean;
	isExpanded: boolean;
	baseTrackHeight: number;
	expandedContent: React.ReactNode;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
}) {
	const editor = useEditor();
	const visibleElement = displayElement ?? element;
	const { inTicks, outTicks } = fitPresetSpans(
		readPresetSettings(visibleElement.params),
		visibleElement.duration,
	);
	const isReducedOpacity =
		(canElementBeHidden(visibleElement) && visibleElement.hidden) ||
		isDropTarget;
	return (
		<div
			className="absolute top-0 bottom-0"
			style={{
				left: `${ELEMENT_RING_WIDTH_PX}px`,
				right: `${ELEMENT_RING_WIDTH_PX}px`,
			}}
		>
			<div
				className="absolute inset-0 rounded-sm"
				style={
					isSelected
						? {
								boxShadow: `0 0 0 ${ELEMENT_RING_WIDTH_PX}px var(--primary)`,
							}
						: undefined
				}
			>
				<div
					className={cn(
						"absolute inset-0 overflow-hidden rounded-sm",
						isExpanded && "bg-background",
					)}
				>
					<button
						type="button"
						tabIndex={-1}
						className="absolute inset-0 size-full flex flex-col"
						onClick={(event) => onElementClick({ event, element })}
						onMouseDown={(event) => onElementMouseDown({ event, element })}
						onDoubleClick={
							isCompoundElement(element)
								? (event) => {
										event.stopPropagation();
										void editor.scenes.enterCompound({
											trackId: track.id,
											elementId: element.id,
										});
									}
								: undefined
						}
					>
						<div
							className={cn(
								"relative flex shrink-0 items-center overflow-hidden",
								isCompoundElement(element)
									? TIMELINE_COMPOUND_THEME.elementClassName
									: getTimelineElementClassName({
											type: track.type,
										}),
								isReducedOpacity && "opacity-50",
							)}
							style={{ height: `${baseTrackHeight}px` }}
						>
							<div className="flex flex-1 min-h-0 h-full items-center overflow-hidden">
								<ElementContent element={visibleElement} track={track} />
							</div>
							{inTicks > 0 && (
								<span
									aria-hidden="true"
									data-animation-span="in"
									className="pointer-events-none absolute inset-y-0 left-0 border-r border-white/20 bg-black/25"
									style={{
										width: `${(100 * inTicks) / visibleElement.duration}%`,
									}}
								/>
							)}
							{outTicks > 0 && (
								<span
									aria-hidden="true"
									data-animation-span="out"
									className="pointer-events-none absolute inset-y-0 right-0 border-l border-white/20 bg-black/25"
									style={{
										width: `${(100 * outTicks) / visibleElement.duration}%`,
									}}
								/>
							)}
						</div>
						{expandedContent}
					</button>
				</div>
			</div>

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						element={element}
						onResizeStart={onResizeStart}
					/>
					<ResizeHandle
						side="right"
						element={element}
						onResizeStart={onResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function ResizeHandle({
	side,
	element,
	onResizeStart,
}: {
	side: "left" | "right";
	element: TimelineElementType;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		side: "left" | "right";
	}) => void;
}) {
	const { t } = useI18n();
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={cn(
				"absolute top-0 bottom-0 w-2",
				isLeft ? "-left-1 cursor-w-resize" : "-right-1 cursor-e-resize",
			)}
			onMouseDown={(event) => onResizeStart({ event, element, side })}
			onClick={(event) => event.stopPropagation()}
			aria-label={t(
				isLeft ? "timeline.leftResizeHandle" : "timeline.rightResizeHandle",
			)}
		></button>
	);
}

/** A keyframe's time for its accessible name: seconds on the timeline, as the ruler counts them. */
function keyframeSeconds(time: number, locale: string): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(time / TICKS_PER_SECOND);
}

/** The diamond is 14 px: the hit area around it is larger, more so on touch screens. */
const KEYFRAME_HIT_AREA = "before:absolute before:-inset-1 before:content-[''] pointer-coarse:before:-inset-2.5";

export function KeyframeIndicators({
	indicators,
	dragState,
	displayedStartTime,
	elementLeft,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	indicators: KeyframeIndicator[];
	dragState: KeyframeDragState;
	displayedStartTime: MediaTime;
	elementLeft: number;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { t, locale } = useI18n();
	const { isKeyframeSelected } = useKeyframeSelection();
	const orderedKeyframes = indicators.flatMap(
		(indicator) => indicator.keyframes,
	);

	return indicators.map((indicator) => {
		const isIndicatorSelected = indicator.keyframes.some((keyframe) =>
			isKeyframeSelected({ keyframe }),
		);
		const isBeingDragged = indicator.keyframes.some((keyframe) =>
			dragState.draggingKeyframeIds.has(keyframe.keyframeId),
		);
		const visualOffsetPx = getVisualOffsetPx({
			indicatorTime: indicator.time,
			indicatorOffsetPx: indicator.offsetPx,
			isBeingDragged,
			displayedStartTime,
			elementLeft,
		});

		return (
			<button
				key={indicator.time}
				type="button"
				className={cn("pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab mr-0.5", KEYFRAME_HIT_AREA)}
				style={{ left: visualOffsetPx }}
				onMouseDown={(event) =>
					onKeyframeMouseDown({ event, keyframes: indicator.keyframes })
				}
				onClick={(event) =>
					onKeyframeClick({
						event,
						keyframes: indicator.keyframes,
						orderedKeyframes,
						indicatorTime: indicator.time,
					})
				}
				aria-label={t("timeline.keyframesAt", {
					count: indicator.keyframes.length,
					time: keyframeSeconds(displayedStartTime + indicator.time, locale),
				})}
				aria-pressed={isIndicatorSelected}
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					className={cn(
						"size-3.5 text-black",
						isIndicatorSelected ? "fill-primary" : "fill-white",
					)}
					strokeWidth={1.5}
				/>
			</button>
		);
	});
}

function ExpandedKeyframeLanes({
	rows,
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	keyframeDragState,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
	containerRef,
	onLaneMouseDown,
	onLaneClick,
	selectionBox,
	isBoxSelecting,
}: {
	rows: ExpandedRow[];
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	keyframeDragState: KeyframeDragState;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onLaneMouseDown: (event: React.MouseEvent) => void;
	onLaneClick: (event: React.MouseEvent) => void;
	selectionBox: {
		bounds: SelectionBoxBounds;
	} | null;
	isBoxSelecting: boolean;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { t, locale } = useI18n();
	const { isKeyframeSelected } = useKeyframeSelection();

	const orderedKeyframes = useMemo(
		() =>
			[...keyframes]
				.sort(
					(a, b) =>
						a.time - b.time || a.propertyPath.localeCompare(b.propertyPath),
				)
				.map((kf) => ({
					trackId,
					elementId,
					propertyPath: kf.propertyPath,
					keyframeId: kf.id,
				})),
		[keyframes, trackId, elementId],
	);

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (keyframe lanes); keyboard control over keyframes is via global timeline shortcuts, not per-element focus.
		<div
			ref={containerRef}
			className="relative flex flex-col"
			onMouseDown={onLaneMouseDown}
			onClick={onLaneClick}
		>
			{rows.map((row) => {
				const laneKeyframes = keyframes.filter(
					(kf) => kf.propertyPath === row.propertyPath,
				);
				return (
					<div
						key={row.propertyPath}
						className={cn("relative flex items-center bg-muted/50")}
						style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
					>
						{laneKeyframes.map((kf) => {
							const keyframeRef: SelectedKeyframeRef = {
								trackId,
								elementId,
								propertyPath: row.propertyPath,
								keyframeId: kf.id,
							};
							const isBeingDragged = keyframeDragState.draggingKeyframeIds.has(
								kf.id,
							);
							const kfLeft = timelineTimeToSnappedPixels({
								time: displayedStartTime + kf.time,
								zoomLevel,
							});
							const offsetPx = kfLeft - elementLeft;
							const visualOffset = getVisualOffsetPx({
								indicatorTime: kf.time,
								indicatorOffsetPx: offsetPx,
								isBeingDragged,
								displayedStartTime,
								elementLeft,
							});
							const isSelected = isKeyframeSelected({
								keyframe: keyframeRef,
							});

							return (
								<button
									key={kf.id}
									type="button"
									className={cn(
										"pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab",
										KEYFRAME_HIT_AREA,
										isBoxSelecting && "pointer-events-none",
									)}
									style={{ left: visualOffset }}
									onMouseDown={(event) => {
										event.stopPropagation();
										onKeyframeMouseDown({
											event,
											keyframes: [keyframeRef],
										});
									}}
									onClick={(event) => {
										event.stopPropagation();
										onKeyframeClick({
											event,
											keyframes: [keyframeRef],
											orderedKeyframes,
											indicatorTime: kf.time,
										});
									}}
									aria-label={t("timeline.keyframeAt", {
										property: row.labelKey ? t(row.labelKey) : row.fallbackLabel ?? row.propertyPath,
										time: keyframeSeconds(displayedStartTime + kf.time, locale),
									})}
									aria-pressed={isSelected}
								>
									<HugeiconsIcon
										icon={KeyframeIcon}
										className={cn(
											"size-3.5 text-black mr-1",
											isSelected ? "fill-primary" : "fill-white",
										)}
										strokeWidth={1.5}
									/>
								</button>
							);
						})}
					</div>
				);
			})}
			{selectionBox && <SelectionBox bounds={selectionBox.bounds} />}
		</div>
	);
}

interface ElementContentProps {
	element: TimelineElementType;
	track: ClipTrack;
}

function TextElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "text" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start pl-2">
			<span className="truncate text-xs text-white">
				{typeof element.params.content === "string" ? element.params.content : ""}
			</span>
		</div>
	);
}

function EffectElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "effect" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start gap-1 pl-2">
			<HugeiconsIcon
				icon={MagicWand05Icon}
				className="size-4 shrink-0 text-white"
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function StickerElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "sticker" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={resolveStickerId({
					stickerId: element.stickerId,
					options: { width: 20, height: 20 },
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function GraphicElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "graphic" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={buildGraphicPreviewUrl({
					definitionId: element.definitionId,
					params: element.params,
					size: 20,
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function AudioElementContent({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const pixelsPerSecond = useContext(PixelsPerSecondContext);
	const timelineLeft = useContext(ClipLeftContext);
	if (pixelsPerSecond === null) {
		throw new Error(
			"AudioElementContent must be rendered inside PixelsPerSecondContext.Provider",
		);
	}
	const mediaAsset = useTimelineMediaAsset(
		element.sourceType === "upload" ? element.mediaId : null,
	);

	const audioBuffer =
		element.sourceType === "library" ? element.buffer : undefined;
	const audioUrl =
		element.sourceType === "library" ? element.sourceUrl : mediaAsset?.url;
	const sourceFile =
		element.sourceType === "upload" ? mediaAsset?.file : undefined;
	const sourceKey =
		element.sourceType === "upload"
			? buildWaveformSourceKey({ kind: "media", id: element.mediaId })
			: buildWaveformSourceKey({ kind: "library", id: element.sourceUrl });
	const mediaLabel = mediaAsset?.name ?? element.name;
	const gainSamples = useMemo(
		() =>
			buildWaveformGainSamples({
				element,
				count: WAVEFORM_GAIN_SAMPLE_COUNT,
			}),
		[element],
	);
	if (audioBuffer || audioUrl || sourceFile) {
		return (
			<div className="group/audio relative size-full">
				<MediaElementHeader name={mediaLabel} hasFade={false} />
				<div className="absolute inset-x-0 top-5 bottom-0 overflow-hidden">
					<AudioWaveform
						sourceKey={sourceKey}
						sourceFile={sourceFile}
						audioBuffer={audioBuffer}
						audioUrl={audioUrl}
						gainSamples={gainSamples}
						pixelsPerSecond={pixelsPerSecond}
						timelineLeft={timelineLeft}
						clipDurationSec={element.duration / TICKS_PER_SECOND}
						retime={element.retime}
						sourceStartSec={element.trimStart / TICKS_PER_SECOND}
						color={TIMELINE_TRACK_THEME.audio.waveformColor}
					/>
					<AudioVolumeLine element={element} trackId={trackId} />
				</div>
			</div>
		);
	}

	return (
		<div className="group/audio relative size-full">
			<div className="flex size-full items-center pl-2">
				<span className="text-foreground/80 truncate text-xs">
					{element.name}
				</span>
			</div>
			<AudioVolumeLine element={element} trackId={trackId} />
		</div>
	);
}

function EffectsButton({
	element,
	track,
}: {
	element: VideoElement | ImageElement;
	track: ClipTrack;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const setActiveTab = usePropertiesStore((s) => s.setActiveTab);

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		editor.selection.setSelectedElements({
			elements: [{ trackId: track.id, elementId: element.id }],
		});
		setActiveTab({ elementType: element.type, tabId: "effects" });
	};

	return (
		<button
			type="button"
			data-timeline-effects
			aria-label={t("properties.openEffects")}
			className="flex shrink-0 justify-center text-white cursor-pointer"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={handleClick}
		>
			<HugeiconsIcon icon={MagicWand05Icon} size={12} />
		</button>
	);
}

export function getClipThumbnailUrl(
	element: VideoElement | ImageElement,
	mediaAsset: MediaAsset | undefined,
) {
	return element.type === "video"
		? mediaAsset?.thumbnailUrl
		: (mediaAsset?.thumbnailUrl ?? mediaAsset?.url);
}

function TiledMediaContent({
	element,
	track,
}: {
	element: VideoElement | ImageElement;
	track: ClipTrack;
}) {
	const mediaAsset = useTimelineMediaAsset(element.mediaId);
	const { ref, thumbnailUrl } = useVisibleThumbnail(mediaAsset);
	const imageUrl = thumbnailUrl ?? getClipThumbnailUrl(element, mediaAsset);

	if (!imageUrl) {
		return (
			<div ref={ref} className="flex size-full min-w-0 items-center">
				<span className="text-foreground/80 truncate text-xs">{element.name}</span>
			</div>
		);
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const tileWidth = trackHeight * THUMBNAIL_ASPECT_RATIO;

	return (
		<div ref={ref} className="absolute inset-0">
			<div
				className="absolute inset-0"
				style={{
					backgroundColor: "var(--muted)",
					backgroundImage: `url(${imageUrl})`,
					backgroundRepeat: "repeat-x",
					backgroundSize: `${tileWidth}px ${trackHeight}px`,
					backgroundPosition: "left center",
					pointerEvents: "none",
				}}
			/>
			<MediaElementHeader
				name={mediaAsset?.name}
				leading={
					hasElementEffects({ element }) ? (
						<EffectsButton element={element} track={track} />
					) : null
				}
				hasFade={true}
			/>
		</div>
	);
}

function MediaElementHeader({
	name,
	leading,
	hasFade,
}: {
	name?: string | null;
	leading?: ReactNode;
	hasFade?: boolean;
}) {
	if (!name && !leading) {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-0 left-0 flex h-5 w-full bg-linear-to-b pt-1",
				hasFade && "from-black/30 to-transparent",
			)}
		>
			{leading && <div className="pl-1">{leading}</div>}
			{name && (
				<span className="truncate px-1.5 text-[0.6rem] leading-tight text-white/75">
					{name}
				</span>
			)}
		</div>
	);
}

const ElementContent = memo(function ElementContent({
	element,
	track,
}: ElementContentProps) {
	switch (element.type) {
		case "text":
			return <TextElementContent element={element} />;
		case "effect":
			return <EffectElementContent element={element} />;
		case "sticker":
			return <StickerElementContent element={element} />;
		case "graphic":
			return <GraphicElementContent element={element} />;
		case "audio":
			return <AudioElementContent element={element} trackId={track.id} />;
		case "video":
		case "image":
			return <TiledMediaContent element={element} track={track} />;
		case "compound":
			return <CompoundElementContent element={element} track={track} />;
	}
});

function CompoundElementContent({
	element,
	track,
}: {
	element: CompoundElement;
	track: ClipTrack;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [isVisible, setIsVisible] = useState(false);
	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		// Account for clipping by both axes of the tracks scroller.
		const observer = new IntersectionObserver(
			([entry]) => setIsVisible(entry.isIntersecting && entry.intersectionRatio > 0),
			{ threshold: [0, Number.EPSILON] },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return (
		<div ref={ref} className="relative size-full">
			{isVisible &&
				(track.type === "audio" ? (
					<CompoundAudioLanes element={element} />
				) : (
					<CompoundThumbnailStrip element={element} />
				))}
			<div
				className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
				style={{ backgroundColor: TIMELINE_COMPOUND_THEME.accentColor }}
			/>
			<div
				className="pointer-events-none absolute top-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-sm px-1 py-px text-black"
				style={{ backgroundColor: TIMELINE_COMPOUND_THEME.accentColor }}
			>
				<HugeiconsIcon icon={Layers01Icon} size={10} className="shrink-0" />
				<span className="truncate text-[0.6rem] leading-tight font-medium">
					{element.name}
				</span>
			</div>
		</div>
	);
}

/** Audio-only compound: its nested clips as bars, one row per nested track. */
function CompoundAudioLanes({ element }: { element: CompoundElement }) {
	const nested = useEditor((e) =>
		e.scenes.getScenes().find((scene) => scene.id === element.sceneId),
	);
	if (!nested || element.duration <= 0) return null;
	const rows = [
		...nested.tracks.overlay,
		nested.tracks.main,
		...nested.tracks.audio,
	].filter((nestedTrack) => nestedTrack.elements.length > 0);
	const windowEnd = element.trimStart + element.duration;
	const toPercent = (time: number) => `${(time / element.duration) * 100}%`;
	return (
		<div className="pointer-events-none absolute inset-x-0 top-5 bottom-1 flex flex-col justify-center gap-0.5">
			{rows.map((row) => (
				<div key={row.id} className="relative max-h-2 min-h-0 flex-1">
					{row.elements.map((nestedElement) => {
						const start = Math.max(nestedElement.startTime, element.trimStart);
						const end = Math.min(
							nestedElement.startTime + nestedElement.duration,
							windowEnd,
						);
						if (end <= start) return null;
						return (
							<div
								key={nestedElement.id}
								className="absolute inset-y-0 rounded-[1px] bg-white/55"
								style={{
									left: toPercent(start - element.trimStart),
									width: toPercent(end - start),
								}}
							/>
						);
					})}
				</div>
			))}
		</div>
	);
}

/** Cached low-res frames of the nested content, rendered off the playback path. */
function CompoundThumbnailStrip({ element }: { element: CompoundElement }) {
	const editor = useEditor();
	const scenes = useEditor((e) => e.scenes.getScenes());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor((e) => e.project.getActive().settings.canvasSize);
	const background = useEditor((e) => e.project.getActive().settings.background);
	const cache = getCompoundThumbnailCache({ editor });
	const key = useMemo(
		() =>
			getCompoundThumbnailKey({
				scenes,
				element,
				canvasSize,
				background,
				mediaAssets,
			}),
		[scenes, element, canvasSize, background, mediaAssets],
	);
	const frames = useSyncExternalStore(
		(listener) => cache.subscribe(listener),
		() => cache.get(key),
		() => undefined,
	);
	const graphics = useSyncExternalStore(rendererDevice.subscribe, rendererDevice.getSnapshot, rendererDevice.getSnapshot);

	useEffect(() => {
		if (graphics.state !== "ready" || cache.get(key)) return;
		cache.request(key, ({ shouldStop }) =>
			renderCompoundThumbnails({ editor, element, shouldStop }),
		);
		return () => cache.cancel(key);
	}, [cache, key, editor, element, graphics.state]);

	const slots = Array.from({ length: COMPOUND_THUMBNAIL_COUNT }, (_, slot) => ({
		slot,
		frame: frames?.[slot],
	}));
	return (
		<div className="pointer-events-none absolute inset-0 flex">
			{slots.map(({ slot, frame }) => (
				<div
					key={slot}
					className="h-full min-w-0 flex-1 bg-cover bg-center"
					style={frame ? { backgroundImage: `url(${frame})` } : undefined}
				/>
			))}
		</div>
	);
}

function CopyMenuItem() {
	const { t } = useI18n();
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<HugeiconsIcon icon={Copy01Icon} />}
		>
			{t("common.copy")}
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	isMuted: boolean;
}) {
	const { t } = useI18n();
	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={VolumeMute02Icon} />;
		}
		return isMuted ? (
			<HugeiconsIcon icon={VolumeOffIcon} />
		) : (
			<HugeiconsIcon icon={VolumeHighIcon} />
		);
	};

	return (
		<ActionMenuItem action="toggle-elements-muted-selected" icon={getIcon()}>
			{isMuted ? t("timeline.unmute") : t("timeline.mute")}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	element,
	isMultipleSelected,
	isCurrentElementSelected,
}: {
	element: TimelineElementType;
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
}) {
	const { t } = useI18n();
	const isHidden = canElementBeHidden(element) && element.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={ViewOffSlashIcon} />;
		}
		return isHidden ? (
			<HugeiconsIcon icon={ViewIcon} />
		) : (
			<HugeiconsIcon icon={ViewOffSlashIcon} />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-elements-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? t("timeline.show") : t("timeline.hide")}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	elementType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	elementType: TimelineElementType["type"];
	selectedCount: number;
}) {
	const { t } = useI18n();
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<HugeiconsIcon icon={Delete02Icon} />}
		>
			{isMultipleSelected && isCurrentElementSelected
				? t("timeline.deleteElements", { count: selectedCount })
				: t(elementType === "text" ? "timeline.deleteText" : "timeline.deleteClip")}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onClick" | "textRight"> & {
	action: TActionWithOptionalArgs;
	children: ReactNode;
}) {
	return (
		<ContextMenuItem
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut({ action })}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
