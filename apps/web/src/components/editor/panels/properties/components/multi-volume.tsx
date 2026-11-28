"use client";

import { useRef, useState } from "react";
import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type { ElementRef, TimelineElement } from "@/timeline/types";
import type { ElementUpdate } from "@/timeline/update-pipeline";

/** Clips whose volume this changes: audio, video and compound clips. */
const hasVolume = (element: TimelineElement) => element.type === "audio" || element.type === "video" || element.type === "compound";

/** The volume changes for `delta` dB from where each clip started, within the volume range. */
export function relativeVolumeUpdates(start: ReadonlyMap<string, { trackId: string; volume: number }>, delta: number): ElementUpdate[] {
	return [...start].map(([elementId, { trackId, volume }]) => ({
		trackId, elementId,
		patch: { params: { volume: Math.round(Math.max(VOLUME_DB_MIN, Math.min(VOLUME_DB_MAX, volume + delta)) * 100) / 100 } } as Partial<TimelineElement>,
	}));
}

/**
 * With several clips selected: drag the handle to move all their volumes by the same number of dB
 * (each from its own level), as one Undo step.
 */
export function MultiVolumeControl({ refs }: { refs: readonly ElementRef[] }) {
	const editor = useEditor();
	const { t } = useI18n();
	const [delta, setDelta] = useState(0);
	const latest = useRef(0);
	const start = useRef<Map<string, { trackId: string; volume: number }> | null>(null);
	const audible = editor.timeline.getElementsWithTracks({ elements: [...refs] }).filter(({ element }) => hasVolume(element));
	if (audible.length < 2) return null;

	const reset = () => {
		start.current = null;
		latest.current = 0;
		setDelta(0);
	};
	const shown = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
	return (
		<div className="flex flex-col gap-1.5 px-4 pt-4">
			<span className="text-muted-foreground text-xs">{t("properties.volumeAll", { count: audible.length })}</span>
			<NumberField
				icon="dB"
				aria-label={t("properties.volumeAll", { count: audible.length })}
				value={shown}
				readOnly
				dragSensitivity={0.1}
				beginScrubGesture={editor.timeline.beginPreviewGesture}
				onScrub={(value) => {
					start.current ??= new Map(audible.map(({ track, element }) => [element.id, {
						trackId: track.id, volume: typeof (element.params as { volume?: unknown }).volume === "number" ? (element.params as { volume: number }).volume : 0,
					}]));
					latest.current = Math.round(value * 10) / 10;
					setDelta(latest.current);
					editor.timeline.previewElementUpdates({ updates: relativeVolumeUpdates(start.current, latest.current) });
				}}
				onScrubEnd={() => {
					if (start.current) editor.timeline.updateElements({ updates: relativeVolumeUpdates(start.current, latest.current) });
					reset();
				}}
				onScrubCancel={() => {
					editor.timeline.discardPreview();
					reset();
				}}
			/>
		</div>
	);
}
