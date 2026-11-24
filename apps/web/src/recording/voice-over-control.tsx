"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Circle, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import type { VoiceOver } from "./voice-over";

export function VoiceOverControl() {
	const { t } = useI18n();
	const { voiceOver } = useEditor();
	useEditor((editor) => editor.scenes.getActiveSceneOrNull()?.id);
	const state = useSyncExternalStore(voiceOver.subscribe, voiceOver.getSnapshot, voiceOver.getServerSnapshot);
	const { phase, preferences } = state;
	const label = t("shortcuts.action.record-voice-over");
	const capturing = voiceOver.isCapturing();
	const open = phase === "setup";

	useEffect(() => () => voiceOver.closeSetup(), [voiceOver]);

	return (
		<>
			<Popover open={open} onOpenChange={(next) => {
				if (next) voiceOver.toggle();
				else voiceOver.closeSetup();
			}}>
				<PopoverTrigger asChild>
					<Button variant={open ? "secondary" : "text"} size="icon" aria-label={label} title={label}
						className={capturing ? "text-red-500" : undefined}
						disabled={phase === "saving" || phase === "recovery"}>
						<Mic />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" side="top" className="grid w-72 gap-3">
					<label className="grid gap-1.5 text-sm">
						{t("recording.microphone")}
						<select
							className="bg-background border-input min-w-0 w-full rounded-md border px-2 py-1.5"
							value={preferences.deviceId}
							disabled={!state.ready}
							onChange={(event) => voiceOver.changePreferences({ deviceId: event.target.value })}
						>
							<option value="">{t("recording.defaultMicrophone")}</option>
							{state.devices.filter(({ deviceId }) => deviceId && deviceId !== "default").map((device, index) => (
								<option key={device.deviceId} value={device.deviceId}>
									{device.label || t("recording.numberedMicrophone", { number: index + 1 })}
								</option>
							))}
						</select>
					</label>
					<LevelMeter voiceOver={voiceOver} />
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={preferences.muteProject}
							onChange={(event) => voiceOver.changePreferences({ muteProject: event.target.checked })} />
						{t("recording.muteProject")}
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={preferences.noiseSuppression}
							onChange={(event) => voiceOver.changePreferences({ noiseSuppression: event.target.checked })} />
						{t("recording.noiseReduction")}
					</label>
					{state.error && <p role="alert" className="text-destructive text-sm">{t(state.error)}</p>}
					{!state.ready && !state.error && (
						<p role="status" className="text-muted-foreground text-sm">{t("recording.connecting")}</p>
					)}
					{state.error ? (
						<Button variant="outline" onClick={() => voiceOver.retryMicrophone()}>{t("recording.retry")}</Button>
					) : (
						<Button variant="destructive" size="lg" disabled={!state.ready} onClick={() => voiceOver.record()}>
							<Circle className="fill-current" /> {t("recording.record")}
						</Button>
					)}
				</PopoverContent>
			</Popover>
			{phase !== "idle" && !open && createPortal(
				<div className="bg-popover text-popover-foreground fixed right-4 bottom-4 z-40 grid w-72 max-w-[calc(100vw-2rem)] gap-2.5 rounded-md border p-3 shadow-lg"
					role="region" aria-label={label}>
					{capturing && phase !== "recording" && (
						<div className="flex items-center justify-between gap-3">
							<span role="status" className="text-sm font-medium">
								{phase === "starting" ? t("recording.starting") : state.ready
									? t("recording.countIn", { count: state.count }) : t("recording.connecting")}
							</span>
							<Button variant="outline" size="sm" onClick={() => voiceOver.stop()}>{t("recording.stop")}</Button>
						</div>
					)}
					{phase === "recording" && (
						<>
							<div className="flex items-center justify-between gap-2">
								<span role="status" className="flex items-center gap-2 text-sm font-medium">
									<Circle className="size-2.5 fill-red-500 text-red-500" /> {t("recording.recording")}
								</span>
								<Elapsed startedAt={state.startedAt} />
							</div>
							<LevelMeter voiceOver={voiceOver} />
							<Button variant="destructive" size="sm" onClick={() => voiceOver.stop()}>
								<Square className="fill-current" /> {t("recording.stop")}
							</Button>
						</>
					)}
					{phase === "saving" && <p role="status" className="text-sm">{t("recording.saving")}</p>}
					{phase === "review" && (
						<>
							<div className="text-sm font-medium">{t("recording.voiceOverTakes")}</div>
							<div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
								{state.takes.map(({ mediaId }, index) => (
									<Button key={mediaId} size="sm" variant={mediaId === state.activeTake ? "default" : "outline"}
										aria-pressed={mediaId === state.activeTake} onClick={() => voiceOver.swap(mediaId)}>
										{t("recording.take", { number: index + 1 })}
									</Button>
								))}
							</div>
							<div className="flex justify-end gap-2">
								<Button size="sm" variant="outline" onClick={() => voiceOver.retake()}>{t("recording.retake")}</Button>
								<Button size="sm" onClick={() => voiceOver.done()}>{t("recording.done")}</Button>
							</div>
						</>
					)}
					{phase === "recovery" && (
						<>
							{state.error && <p role="alert" className="text-sm">{t(state.error)}</p>}
							<div className="flex justify-end gap-2">
								{voiceOver.canRetry() && (
									<Button size="sm" variant="outline" onClick={() => voiceOver.retryTake()}>{t("recording.retry")}</Button>
								)}
								<Button size="sm" onClick={voiceOver.saveWav}>{t("recording.saveWav")}</Button>
							</div>
						</>
					)}
				</div>,
				document.body,
			)}
		</>
	);
}

function LevelMeter({ voiceOver }: { voiceOver: VoiceOver }) {
	const { t } = useI18n();
	const meter = useRef<HTMLMeterElement>(null);
	useEffect(() => voiceOver.subscribeLevel((peak) => {
		if (meter.current) meter.current.value = Math.min(1, Math.sqrt(peak));
	}), [voiceOver]);
	return <meter ref={meter} min={0} max={1} high={0.9} optimum={0.6} defaultValue={0}
		className="h-3 w-full" aria-label={t("recording.inputLevel")} />;
}

function Elapsed({ startedAt }: { startedAt: number }) {
	const text = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const tick = () => {
			const seconds = Math.floor((performance.now() - startedAt) / 1000);
			const format = (value: number) => String(value).padStart(2, "0");
			if (text.current) text.current.textContent = `${format(Math.floor(seconds / 60))}:${format(seconds % 60)}`;
		};
		const timer = setInterval(tick, 1000);
		tick();
		return () => clearInterval(timer);
	}, [startedAt]);
	return <span ref={text} className="font-mono text-sm tabular-nums">00:00</span>;
}
