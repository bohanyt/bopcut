"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PreviewGesture } from "@/core/managers/timeline-manager";
import { createPortal } from "react-dom";
import { useEditor } from "@/editor/use-editor";
import {
	getDbFromLinePos,
	getLinePosFromDb,
} from "@/timeline/audio-display";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { getElementVolume, hasAnimatedVolume } from "@/timeline/audio-state";
import type { AudioElement } from "@/timeline/types";
import {
	clamp,
	formatNumberForDisplay,
	getFractionDigitsForStep,
	isNearlyEqual,
	snapToStep,
} from "@/utils/math";
import { cn } from "@/utils/ui";
import { finishFocusedField } from "@/utils/browser";

const HIT_AREA_HEIGHT_PX = 14;
const TOOLTIP_OFFSET_PX = 10;
const VOLUME_STEP = 0.1;
const VOLUME_FRACTION_DIGITS = getFractionDigitsForStep({ step: VOLUME_STEP });

function clampVolume({ value }: { value: number }): number {
	return clamp({
		value: snapToStep({ value, step: VOLUME_STEP }),
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
	});
}

function getVolumeFromPointer({
	clientY,
	rect,
}: {
	clientY: number;
	rect: DOMRect;
}): number {
	const clampedOffset = clamp({
		value: clientY - rect.top,
		min: 0,
		max: rect.height,
	});
	const progressPercent =
		rect.height <= 0 ? 0 : (clampedOffset / rect.height) * 100;
	return clampVolume({ value: getDbFromLinePos({ percent: progressPercent }) });
}

export function AudioVolumeLine({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const editor = useEditor();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointerId: number; owner: PreviewGesture } | null>(null);
	const startVolumeRef = useRef(getElementVolume({ element }));
	const lastPreviewVolumeRef = useRef(getElementVolume({ element }));
	const hasChangedRef = useRef(false);
	const [isDragging, setIsDragging] = useState(false);
	const [tooltipClientPos, setTooltipClientPos] = useState<{
		x: number;
		y: number;
	} | null>(null);

	const hasAnimatedEnvelope = hasAnimatedVolume({ element });
	const currentVolume = getElementVolume({ element });
	const lineTop = `${getLinePosFromDb({ db: currentVolume })}%`;

	const volumeLabel = `${formatNumberForDisplay({
		value: currentVolume,
		fractionDigits: VOLUME_FRACTION_DIGITS,
	})} dB`;

	const previewVolume = useCallback(
		(nextVolume: number) => {
			if (
				isNearlyEqual({
					leftValue: nextVolume,
					rightValue: lastPreviewVolumeRef.current,
				})
			) {
				return;
			}

			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: { params: { volume: nextVolume } },
					},
				],
			});
			lastPreviewVolumeRef.current = nextVolume;
			hasChangedRef.current = !isNearlyEqual({
				leftValue: startVolumeRef.current,
				rightValue: nextVolume,
			});
		},
		[editor, element.id, trackId],
	);

	const resetDrag = useCallback(() => {
		drag.current = null;
		setIsDragging(false);
		setTooltipClientPos(null);
	}, []);

	useLayoutEffect(() => () => drag.current?.owner.cancel(), [
		element.id,
		trackId,
		hasAnimatedEnvelope,
	]);

	const updateFromPointer = useCallback(
		({ clientX, clientY }: { clientX: number; clientY: number }) => {
			const rect = surfaceRef.current?.getBoundingClientRect();
			if (!rect) {
				return;
			}

			setTooltipClientPos({
				x: clientX + TOOLTIP_OFFSET_PX,
				y: clientY - TOOLTIP_OFFSET_PX,
			});
			previewVolume(getVolumeFromPointer({ clientY, rect }));
		},
		[previewVolume],
	);

	const handleClick = useCallback((event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const handleMouseDown = useCallback((event: React.MouseEvent) => {
		event.stopPropagation();
	}, []);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0 || !event.isPrimary || drag.current) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			finishFocusedField(event.currentTarget);
			editor.selection.setSelectedElements({
				elements: [{ trackId, elementId: element.id }],
			});
			const { currentTarget: target, pointerId } = event;
			const owner = editor.timeline.beginPreviewGesture(() => {
				resetDrag();
				if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
			});
			drag.current = { pointerId, owner };
			startVolumeRef.current = currentVolume;
			lastPreviewVolumeRef.current = currentVolume;
			hasChangedRef.current = false;
			setIsDragging(true);
			target.setPointerCapture(pointerId);
			updateFromPointer({
				clientX: event.clientX,
				clientY: event.clientY,
			});
		},
		[currentVolume, editor, element.id, resetDrag, trackId, updateFromPointer],
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent) => {
			if (drag.current?.pointerId !== event.pointerId) {
				return;
			}

			event.preventDefault();
			updateFromPointer({
				clientX: event.clientX,
				clientY: event.clientY,
			});
		},
		[updateFromPointer],
	);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent) => {
			const gesture = drag.current;
			if (gesture?.pointerId !== event.pointerId) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			gesture.owner.finish();
			resetDrag();
			if (hasChangedRef.current) editor.timeline.commitPreview();
			else editor.timeline.discardPreview();
		},
		[editor.timeline, resetDrag],
	);

	const handlePointerCancel = useCallback(
		(event: React.PointerEvent) => {
			const gesture = drag.current;
			if (gesture?.pointerId !== event.pointerId) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			gesture.owner.cancel();
		},
		[],
	);

	if (hasAnimatedEnvelope) {
		return null;
	}

	return (
		<div className="pointer-events-none absolute inset-0">
			<div ref={surfaceRef} className="absolute inset-0">
				<div
					className={cn(
						"pointer-events-none absolute inset-x-0 -translate-y-1/2 border-t transition-colors",
						isDragging
							? "border-white"
							: "border-white/50 group-hover/audio:border-white/80",
					)}
					style={{ top: lineTop }}
				/>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- custom drag widget for clip volume; pointer events drive the interaction, the click/mousedown handlers are propagation-stoppers. The a11y-correct long-term shape is <input type="range"> with a custom thumb. */}
				<div
					className="absolute inset-x-0 -translate-y-1/2 touch-none cursor-ns-resize pointer-events-auto"
					style={{ top: lineTop, height: `${HIT_AREA_HEIGHT_PX}px` }}
					onClick={handleClick}
					onMouseDown={handleMouseDown}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerCancel}
					onLostPointerCapture={handlePointerCancel}
					title="Drag to adjust clip volume"
				/>
				{isDragging &&
					tooltipClientPos &&
					createPortal(
						<div
							className="pointer-events-none fixed left-0 top-0 z-50 -translate-y-full rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
							style={{
								transform: `translate(${tooltipClientPos.x}px, ${tooltipClientPos.y}px)`,
							}}
						>
							{volumeLabel}
						</div>,
						document.body,
					)}
			</div>
		</div>
	);
}
