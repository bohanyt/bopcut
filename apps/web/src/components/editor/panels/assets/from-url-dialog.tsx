"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { MediaImportSession } from "@/core/managers/media-manager";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeSectionRequest } from "@/retrieval/time";

type Retrieved = { path: string; name: string; error?: string };

/**
 * Adds a section of an online video (or only its sound) to the project. The server fetches just that
 * range with yt-dlp, so a few seconds of a long stream arrive without downloading the whole video.
 */
export function FromUrlDialog({
	open,
	onOpenChange,
	onFiles,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onFiles: (files: File[], session: MediaImportSession) => Promise<void> | void;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const [url, setUrl] = useState("");
	const [start, setStart] = useState("");
	const [end, setEnd] = useState("");
	const [audioOnly, setAudioOnly] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		const request = normalizeSectionRequest({ url: url.trim(), start: start.trim(), end: end.trim(), audioOnly }, Number.POSITIVE_INFINITY);
		if (!request.ok) {
			setError(request.error);
			return;
		}
		const session = editor.media.startImport();
		if (!session) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/agent/retrieve", {
				method: "POST",
				signal: session.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "section", ...request.value }),
			});
			const body = (await res.json().catch(() => ({}))) as Retrieved;
			if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
			const file = await fetch(`/api/agent/file?p=${encodeURIComponent(body.path)}`, { signal: session.signal });
			if (!file.ok) throw new Error("the fetched file could not be read");
			const blob = await file.blob();
			const ext = body.path.split(".").pop() ?? "mp4";
			await onFiles([new File([blob], `${body.name}.${ext}`, { type: blob.type })], session);
			if (session.signal.aborted) return;
			onOpenChange(false);
			setUrl("");
			setStart("");
			setEnd("");
		} catch (e) {
			if (!session.signal.aborted) setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("assets.addFromLink")}</DialogTitle>
					<DialogDescription>
						{t("assets.sectionHint")}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="from-url-link">{t("assets.link")}</Label>
						<Input id="from-url-link" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
					</div>
					<div className="flex gap-3">
						<div className="flex flex-1 flex-col gap-1.5">
							<Label htmlFor="from-url-start">{t("assets.start")}</Label>
							<Input id="from-url-start" placeholder="1:02:03" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} />
						</div>
						<div className="flex flex-1 flex-col gap-1.5">
							<Label htmlFor="from-url-end">{t("assets.end")}</Label>
							<Input id="from-url-end" placeholder="1:02:25" value={end} onChange={(e) => setEnd(e.target.value)} disabled={busy} />
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox id="from-url-audio" checked={audioOnly} onCheckedChange={(v) => setAudioOnly(v === true)} disabled={busy} />
						<Label htmlFor="from-url-audio">{t("assets.soundOnly")}</Label>
					</div>
					{error && <p className="text-destructive text-sm">{localizeErrorDetail(error, t)}</p>}
					{busy && <p className="text-muted-foreground text-sm">{t("assets.fetchingSection")}</p>}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						{t("common.cancel")}
					</Button>
					<Button onClick={submit} disabled={busy || !url.trim()}>
						{busy ? t("assets.fetching") : t("common.add")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
