"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useI18n } from "@/i18n/provider";
import type {
	ParamDefinition,
	NumberParamDefinition,
	ParamValue,
} from "@/params";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	parseDecimalInput,
	snapToStep,
} from "@/utils/math";
import { SectionField } from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { Slider } from "@/components/ui/slider";
import type { PreviewGesture } from "@/core/managers/timeline-manager";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/color-picker";
import { FontPicker } from "@/components/ui/font-picker";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePropertyDraft } from "../hooks/use-property-draft";
import { KeyframeToggle } from "./keyframe-toggle";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";

export function PropertyParamField({
	param,
	value,
	clipSeconds,
	onPreview,
	onCommit,
	keyframe,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	keyframe?: {
		isActive: boolean;
		isDisabled: boolean;
		onToggle: () => void;
	};
	/** The clip's length in seconds, for sliders limited to half of it. */
	clipSeconds?: number;
}) {
	const { locale, t } = useI18n();
	const label = t(param.labelKey);
	return (
		<SectionField
			label={label}
			beforeLabel={
				keyframe && param.keyframable !== false ? (
					<KeyframeToggle
						isActive={keyframe.isActive}
						isDisabled={keyframe.isDisabled}
						title={t("properties.toggleKeyframe", { property: label.toLocaleLowerCase(locale) })}
						onToggle={keyframe.onToggle}
					/>
				) : undefined
			}
		>
			<ParamInput
				param={param}
				value={value}
				clipSeconds={clipSeconds}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		</SectionField>
	);
}

function ParamInput({
	param,
	value,
	clipSeconds,
	onPreview,
	onCommit,
}: {
	param: ParamDefinition;
	value: ParamValue;
	clipSeconds?: number;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
}) {
	const { t } = useI18n();
	const { timeline } = useEditor();
	// The label beside a field is not tied to it: each control carries its own name.
	const label = t(param.labelKey);
	if (param.type === "number") {
		return (
			<NumberParamField
				param={param}
				label={label}
				value={typeof value === "number" ? value : Number(value)}
				clipSeconds={clipSeconds}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	if (param.type === "boolean") {
		return (
			<Switch
				aria-label={label}
				checked={Boolean(value)}
				onCheckedChange={(checked) => {
					onPreview(checked);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "select") {
		return (
			<Select
				value={String(value)}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full" aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{param.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{t(option.labelKey)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (param.type === "color") {
		return (
			<ColorPicker
				label={label}
				beginDragGesture={timeline.beginPreviewGesture}
				value={String(value).replace(/^#/, "").toUpperCase()}
				onChange={(color) => onPreview(`#${color}`)}
				onChangeEnd={(color) => {
					onPreview(`#${color}`);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "font") {
		return (
			<FontPicker
				label={label}
				defaultValue={String(value)}
				onValueChange={(family) => {
					onPreview(family);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "text") {
		return (
			<TextParamField
				label={label}
				multiline
				value={String(value)}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	return null;
}

/** `value` is the committed text: what is typed is kept here until it is committed. */
function TextParamField({
	label,
	multiline,
	value,
	onPreview,
	onCommit,
}: {
	label: string;
	multiline: boolean;
	value: string;
	onPreview: (value: string) => void;
	onCommit: () => void;
}) {
	const { timeline } = useEditor();
	const [draft, setDraft] = useState<string | null>(null);
	const cancelled = useRef(false);
	const unmount = useCommittedRef(() => {
		if (draft !== null) onCommit();
	});
	// Another clip was selected while typing.
	useEffect(() => () => unmount.current(), [unmount]);

	const field = {
		"aria-label": label,
		value: draft ?? value,
		onChange: ({ currentTarget }: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			setDraft(currentTarget.value);
			onPreview(currentTarget.value);
		},
		/** Escape leaves the field without committing: the blur that follows drops the edit. */
		onKeyDown: ({ key }: KeyboardEvent) => {
			if (key === "Escape") cancelled.current = true;
		},
		onBlur: () => {
			if (cancelled.current) {
				cancelled.current = false;
				if (draft !== null) timeline.discardPreview();
			} else {
				onCommit();
			}
			setDraft(null);
		},
	};
	return multiline ? (
		<Textarea {...field} />
	) : (
		<input
			className="border-input bg-accent h-9 w-full rounded-md border px-3 text-sm outline-none"
			{...field}
		/>
	);
}

function NumberParamField({
	param,
	label,
	value,
	clipSeconds,
	onPreview,
	onCommit,
}: {
	param: NumberParamDefinition;
	/** The field's accessible name: the short label shown next to it is often a single letter. */
	label: string;
	value: number;
	clipSeconds?: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const { timeline } = useEditor();
	const { min, step, displayMultiplier = 1 } = param;
	const slider = param.slider;
	// A fade is at most half the clip, whether it is typed, dragged or slid.
	const max = slider?.halfOfClip && clipSeconds
		? Math.max(min + step, Math.min(param.max ?? Infinity, (clipSeconds / 2) * displayMultiplier))
		: param.max;
	const displayValue = value * displayMultiplier;
	const clampDisplayValue = (nextDisplayValue: number) =>
		Math.max(
			min,
			max !== undefined ? Math.min(max, nextDisplayValue) : nextDisplayValue,
		);

	const previewFromDisplay = (displayVal: number) => {
		const clamped = clampDisplayValue(
			snapToStep({ value: displayVal, step }),
		);
		onPreview(clamped / displayMultiplier);
	};

	const maxFractionDigits = getFractionDigitsForStep({ step });

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: displayValue,
			maxFractionDigits,
		}),
		parse: (input) => {
			const parsed = parseDecimalInput({ input });
			if (parsed === null) return null;
			return clampDisplayValue(snapToStep({ value: parsed, step }));
		},
		onPreview: previewFromDisplay,
		onCommit,
		onInvalid: () => timeline.discardPreview(),
	});

	const handleReset = () => {
		onPreview(param.default);
		onCommit();
	};

	const sliderMax = max;
	const field = (
		<NumberField
			icon={param.shortLabel}
			aria-label={label}
			value={draft.displayValue}
			dragSensitivity={param.scrubPerPixel ?? "slow"}
			isDefault={value === param.default}
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
			onKeyDown={draft.onKeyDown}
			onScrub={previewFromDisplay}
			onScrubEnd={onCommit}
			beginScrubGesture={timeline.beginPreviewGesture}
			onReset={handleReset}
		/>
	);
	if (!slider || sliderMax === undefined) return field;
	return (
		<div className="flex flex-col gap-2">
			{field}
			<ParamSlider
				label={label}
				min={min}
				max={sliderMax}
				step={step}
				value={displayValue}
				detent={slider.detent}
				onSlide={previewFromDisplay}
				onCommit={onCommit}
				onReset={handleReset}
			/>
		</div>
	);
}

/**
 * A slider for a number: one drag is one preview committed on release (one Undo step); near the
 * detent it settles on it, and a double-click resets the value.
 */
function ParamSlider({ label, min, max, step, value, detent, onSlide, onCommit, onReset }: {
	label: string; min: number; max: number; step: number; value: number; detent?: number;
	onSlide: (value: number) => void; onCommit: () => void; onReset: () => void;
}) {
	const { timeline } = useEditor();
	const gesture = useRef<PreviewGesture | null>(null);
	// The panel shows the saved value while a drag previews: the slider keeps its own until release,
	// so it moves under the pointer and reports the change on release.
	const [sliding, setSliding] = useState<number | null>(null);
	const settle = (next: number) => (detent !== undefined && Math.abs(next - detent) <= (max - min) * 0.02 ? detent : next);
	const end = () => {
		gesture.current?.finish();
		gesture.current = null;
		setSliding(null);
	};
	return (
		<Slider
			aria-label={label}
			min={min}
			max={max}
			step={step}
			value={[Math.max(min, Math.min(max, sliding ?? value))]}
			onPointerDown={() => {
				gesture.current?.finish();
				gesture.current = timeline.beginPreviewGesture(() => {
					gesture.current = null;
					setSliding(null);
				});
			}}
			onValueChange={([next]) => {
				const settled = settle(next);
				setSliding(settled);
				onSlide(settled);
			}}
			onValueCommit={() => {
				onCommit();
				end();
			}}
			onDoubleClick={onReset}
		/>
	);
}
