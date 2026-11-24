import { localizeErrorDetail } from "@/i18n/error-details";
// In and out animation presets for a clip: drawn on top of the clip's own animation, so its keyframes
// stay as they are, and trims, speed changes and copies keep them.
import { useI18n } from "@/i18n/provider";
import type { StaticMessageKey } from "@/i18n/translate";
import { useLayoutEffect, useRef, useState } from "react";
import type { PreviewGesture } from "@/core/managers/timeline-manager";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	ANIMATION_IN_TYPES,
	ANIMATION_OUT_TYPES,
	DEFAULT_IN_SECONDS,
	DEFAULT_OUT_SECONDS,
	PRESET_PARAM,
	type AnimationPresetRequest,
	applyAnimationPresets,
	readAnimationPresets,
	readPresetSettings,
} from "@/animation/presets";
import { getPresetDurationRange } from "@/animation/duration-control";
import type { TimelineElement } from "@/timeline";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";

const PRESET_LABELS: Partial<Record<string, StaticMessageKey>> = {
	none: "params.none",
	fade: "properties.fade",
	pop: "graph.pop",
	impact: "properties.impact",
	blur: "settings.blur",
	typewriter: "properties.typewriter",
	fall: "properties.fall",
	dissolve: "properties.dissolve",
};

const RANGE_KEYS = [
	"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
];

function PresetSide({
	side,
	element,
	trackId,
	current,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	trackId: string;
	current: { type: string; duration: number } | null;
	onApply: (request: AnimationPresetRequest) => void;
}) {
	const { t } = useI18n();
	const types = (side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES).filter(
		(type) => type !== "typewriter" || element.type === "text",
	);
	const type = current?.type ?? "none";
	const apply = (nextType: string, seconds?: number) =>
		onApply({ [side]: { type: nextType, ...(seconds ? { duration: seconds } : {}) } } as AnimationPresetRequest);
	return (
		<>
			<SectionField label={side === "in" ? t("properties.animationIn") : t("properties.animationOut")}>
				<Select value={type} onValueChange={(next) => apply(next)}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["none", ...types].map((option) => (
							<SelectItem key={option} value={option}>
								{t(PRESET_LABELS[option] ?? "params.none")}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SectionField>
			{current && (
				<PresetDuration
					key={type}
					side={side}
					element={element}
					trackId={trackId}
					duration={current.duration}
					defaultDuration={side === "in"
						? DEFAULT_IN_SECONDS[type as keyof typeof DEFAULT_IN_SECONDS]
						: DEFAULT_OUT_SECONDS[type as keyof typeof DEFAULT_OUT_SECONDS]}
					onApply={(seconds) => apply(type, seconds)}
				/>
			)}
		</>
	);
}

function PresetDuration({
	side,
	element,
	trackId,
	duration,
	defaultDuration,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	trackId: string;
	duration: number;
	defaultDuration: number;
	onApply: (seconds: number) => void;
}) {
	const { t } = useI18n();
	const { timeline } = useEditor();
	const { min, max } = getPresetDurationRange(element.duration);
	const clampDuration = (seconds: number) => Math.min(max, Math.max(min, seconds));
	const value = clampDuration(duration);
	const resetValue = clampDuration(defaultDuration);
	const [draft, setDraft] = useState<string | null>(null);
	const drag = useRef<{
		pointerId: number;
		previewing: boolean;
		owner: PreviewGesture;
	} | null>(null);
	const ignoreRangeChanges = useRef(false);
	const label = side === "in" ? t("properties.animationInLength") : t("properties.animationOutLength");
	const durationKey = side === "in" ? PRESET_PARAM.inDuration : PRESET_PARAM.outDuration;

	useLayoutEffect(() => () => drag.current?.owner.cancel(), [
		timeline,
		trackId,
		element.id,
	]);

	return (
		<SectionField label={t("properties.animationLength")}>
			<div className="flex items-center gap-3">
				<input
					type="range"
					aria-label={label}
					min={min}
					max={max}
					step="any"
					value={value}
					disabled={min === max}
					className="accent-primary min-w-0 flex-1 disabled:opacity-50"
					onPointerDown={(event) => {
						if (event.button !== 0 || !event.isPrimary) return;
						const { currentTarget: input, pointerId } = event;
						// Commit a focused number field before the range input starts changing.
						input.focus();
						const owner = timeline.beginPreviewGesture(() => {
							drag.current = null;
							// Native range input events can continue after capture is released.
							ignoreRangeChanges.current = true;
							if (input.hasPointerCapture(pointerId)) input.releasePointerCapture(pointerId);
						});
						ignoreRangeChanges.current = false;
						drag.current = { pointerId, previewing: false, owner };
						input.setPointerCapture(pointerId);
					}}
					onPointerUp={(event) => {
						const gesture = drag.current;
						if (gesture?.pointerId !== event.pointerId) return;
						drag.current = null;
						gesture.owner.finish();
						if (gesture.previewing) timeline.commitPreview();
					}}
					onPointerCancel={(event) => {
						if (drag.current?.pointerId === event.pointerId) drag.current.owner.cancel();
					}}
					onLostPointerCapture={(event) => {
						if (drag.current?.pointerId === event.pointerId) drag.current.owner.cancel();
					}}
					onKeyDown={(event) => {
						if (RANGE_KEYS.includes(event.key)) ignoreRangeChanges.current = false;
					}}
					onChange={(event) => {
						if (ignoreRangeChanges.current) return;
						const raw = event.currentTarget.valueAsNumber;
						const gesture = drag.current;
						// The range input serializes fractional endpoints with reduced precision.
						const seconds = Math.abs(raw - max) < 1e-12
							? max
							: gesture ? clampDuration(Math.round(raw * 100) / 100) : raw;
						const committed = timeline.getTrackById({ trackId })?.elements.find(
							(clip) => clip.id === element.id,
						);
						if (!committed) return;
						if (seconds === readPresetSettings(committed.params)[side]?.seconds) {
							if (gesture?.previewing) {
								timeline.discardPreview();
								gesture.previewing = false;
							}
							return;
						}
						timeline.previewElements({
							updates: [{
								trackId,
								elementId: element.id,
								updates: { params: { ...committed.params, [durationKey]: seconds } },
							}],
						});
						if (gesture) gesture.previewing = true;
						else timeline.commitPreview();
					}}
				/>
				<NumberField
					aria-label={t("properties.animationSeconds", { label })}
					className="w-24 shrink-0 [&_input]:pr-4"
					value={draft ?? String(Number(value.toFixed(3)))}
					suffix="s"
					suffixClassName="right-2 left-auto!"
					disabled={min === max}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => {
						if (draft === null) return;
						setDraft(null);
						const input = draft.trim();
						if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(input)) return;
						const seconds = Number(input.replace(",", "."));
						if (!Number.isFinite(seconds)) return;
						const next = clampDuration(seconds);
						if (next !== duration) onApply(next);
					}}
					isDefault={duration === resetValue}
					onReset={() => onApply(resetValue)}
				/>
			</div>
		</SectionField>
	);
}

export function AnimationTab({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const { renderElement } = useElementPreview({ trackId, elementId: element.id, fallback: element });
	const presets = readAnimationPresets(renderElement);
	const onApply = (request: AnimationPresetRequest) => {
		let next: TimelineElement;
		try {
			next = applyAnimationPresets(element, request);
		} catch (error) {
			toast.error(t("animation.applyFailed"), { description: localizeErrorDetail(error instanceof Error ? error.message : String(error), t) });
			return;
		}
		// One edit, so one undo.
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch: { params: next.params } }],
		});
	};
	return (
		<Section collapsible sectionKey={`${element.id}:animation`}>
			<SectionHeader>
				<SectionTitle>{t("properties.animation")}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<PresetSide side="in" element={renderElement} trackId={trackId} current={presets.in} onApply={onApply} />
					<PresetSide side="out" element={renderElement} trackId={trackId} current={presets.out} onApply={onApply} />
					<p className="text-muted-foreground text-xs">
						{t("properties.animationHint")}
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
