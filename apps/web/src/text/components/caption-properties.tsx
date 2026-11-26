"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import { useEffect, useId, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { TextElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { distributeWordTimings } from "../caption";
import {
	applyTextPreset,
	createTextPreset,
	loadTextPresets,
	saveTextPreset,
	type TextStylePreset,
} from "../presets";

export function CaptionProperties({
	element,
	trackId,
	presetsOnly = false,
}: {
	element: TextElement;
	trackId: string;
	presetsOnly?: boolean;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const timingsId = useId();
	const [presets, setPresets] = useState<TextStylePreset[]>([]);
	const [name, setName] = useState("");
	const [chosen, setChosen] = useState("");
	const [busy, setBusy] = useState(false);
	const report = (error: unknown) =>
		toast.error(localizeErrorDetail(error instanceof Error ? error.message : String(error), t));
	useEffect(() => {
		loadTextPresets().then(setPresets).catch(report);
	}, []);
	const patch = (patch: Partial<TextElement>) =>
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch }],
		});
	const save = async () => {
		setBusy(true);
		try {
			const preset = createTextPreset(
				name,
				element,
				Math.max(
					0,
					Math.min(
						element.duration,
						editor.playback.getCurrentTime() - element.startTime,
					),
				),
			);
			await saveTextPreset(preset);
			setPresets(await loadTextPresets());
			setChosen(preset.name);
			toast.success(t("text.styleSaved"));
		} catch (error) {
			report(error);
		} finally {
			setBusy(false);
		}
	};
	const apply = () => {
		const preset = presets.find((preset) => preset.name === chosen);
		if (!preset) return;
		const selected = editor.selection.getSelectedElements();
		const refs = selected.length
			? selected
			: [{ trackId, elementId: element.id }];
		const tracks = editor.scenes.getActiveScene().tracks;
		const updates = refs.flatMap((ref) => {
			const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
				(track) => track.id === ref.trackId,
			);
			const target = track?.elements.find(
				(target) => target.id === ref.elementId,
			);
			return target?.type === "text"
				? [{ ...ref, patch: applyTextPreset(target, preset) }]
				: [];
		});
		editor.timeline.updateElements({ updates });
		toast.success(t("text.styleApplied", { count: updates.length }));
	};
	return (
		<div className="space-y-3 border-b p-4">
			<div className="text-sm font-medium">{t("text.presets")}</div>
			<div className="flex gap-2">
				<Input
					aria-label={t("text.presetName")}
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("text.presetName")}
				/>
				<Button size="sm" disabled={busy || !name.trim()} onClick={save}>
					{t("common.save")}
				</Button>
			</div>
			{/* In a narrow panel the button moves under the select instead of cutting its text off. */}
			<div className="flex flex-wrap gap-2">
				<select
					aria-label={t("text.preset")}
					className="bg-background h-7 min-w-40 flex-1 rounded border px-2 text-sm"
					value={chosen}
					onChange={(event) => setChosen(event.target.value)}
				>
					<option value="">{t("text.choosePreset")}</option>
					{presets.map((preset) => (
						<option key={preset.name} value={preset.name}>
							{preset.name}
						</option>
					))}
				</select>
				<Button size="sm" disabled={!chosen} onClick={apply}>
					{t("text.applySelected")}
				</Button>
			</div>
			{!presetsOnly &&
				(element.caption ? (
					<>
						<p className="text-muted-foreground text-xs">
							{t("text.timingHint", { timings: element.caption.approximate
								? t("text.approximateTimings")
								: t("text.timedWords") })}
						</p>
						<div className="flex flex-wrap gap-1" aria-label={t("text.emphasisWords")}>
							{element.caption.words.map((word, index) => (
								<Button
									key={index}
									size="sm"
									variant={word.highlight ? "secondary" : "ghost"}
									aria-pressed={!!word.highlight}
									title={t("text.toggleEmphasis", { start: word.start.toFixed(2), end: word.end.toFixed(2) })}
									onClick={() =>
										patch({
											caption: {
												...element.caption!,
												words: element.caption!.words.map((entry, i) =>
													i === index
														? { ...entry, highlight: !entry.highlight }
														: entry,
												),
											},
										})
									}
								>
									{word.text}
								</Button>
							))}
						</div>
					</>
				) : (
					<div className="flex items-center justify-between text-sm">
						<label htmlFor={timingsId}>{t("text.captionTimings")}</label>
						<Switch
							id={timingsId}
							checked={false}
							onCheckedChange={() =>
								patch({
									caption: distributeWordTimings(
										String(element.params.content ?? ""),
										element.duration / TICKS_PER_SECOND,
										element.trimStart / TICKS_PER_SECOND,
									),
									params: {
										...element.params,
										"caption.maxWidth":
											editor.project.getActive().settings.canvasSize.width *
											0.8,
									},
								})
							}
						/>
					</div>
				))}
		</div>
	);
}
