"use client";

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon } from "@hugeicons/core-free-icons";
import type { Inbox, InboxBundle, InboxDraft } from "@/agent/inbox-types";
import { useBundleImport } from "@/agent/use-bundle-import";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useEditor } from "@/editor/use-editor";
import { localizeErrorDetail } from "@/i18n/error-details";
import { useI18n } from "@/i18n/provider";
import { formatDateTime } from "@/utils/date";

/** What an agent made that the person has not opened yet: a bundle to import, a draft waiting for its project. */
export function AgentTab({ inbox, failed, onRetry }: { inbox: Inbox | null; failed: string | null; onRetry: () => void }) {
	const { t } = useI18n();
	if (failed !== null && !inbox) {
		return (
			<main role="alert" className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
				<h3 className="text-lg font-medium">{t("home.inboxFailed")}</h3>
				<details className="text-muted-foreground max-w-md break-words text-xs">
					<summary className="cursor-pointer">{t("common.errorDetails")}</summary>
					<p>{localizeErrorDetail(failed, t)}</p>
				</details>
				<Button onClick={onRetry}>{t("common.retry")}</Button>
			</main>
		);
	}
	if (!inbox) return <main className="text-muted-foreground mx-auto max-w-3xl px-4 py-16 text-center text-sm" role="status">{t("home.inboxLoading")}</main>;
	if (!inbox.bundle && !inbox.draft) {
		return (
			<main className="mx-auto flex max-w-3xl flex-col items-center gap-2 px-4 py-16 text-center">
				<div className="bg-muted/30 flex size-16 items-center justify-center rounded-full">
					<HugeiconsIcon icon={AiMagicIcon} className="text-muted-foreground size-8" />
				</div>
				<h3 className="text-lg font-medium">{t("home.inboxEmpty")}</h3>
				<p className="text-muted-foreground max-w-md">{t("home.inboxEmptyDescription")}</p>
			</main>
		);
	}
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-4 pb-6 sm:px-8">
			{inbox.bundle && <BundleCard bundle={inbox.bundle} />}
			{inbox.draft && <DraftCard draft={inbox.draft} />}
		</main>
	);
}

function When({ iso }: { iso: string }) {
	const { locale } = useI18n();
	const date = new Date(iso);
	if (!iso || Number.isNaN(date.getTime())) return null;
	return <time dateTime={iso}>{formatDateTime({ date, locale })}</time>;
}

function BundleCard({ bundle }: { bundle: InboxBundle }) {
	const { t } = useI18n();
	const { run, status, errorDetail, busy } = useBundleImport();
	return (
		<Card>
			<CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-muted-foreground text-xs font-medium">{t("home.bundleKind")}</p>
					{"error" in bundle ? (
						<p className="text-destructive break-words text-sm">{localizeErrorDetail(bundle.error, t)}</p>
					) : (
						<>
							<h3 className="truncate font-medium">{bundle.name}</h3>
							<p className="text-muted-foreground text-sm">
								{t("home.bundleDetails", { assets: bundle.assets, items: bundle.items })}
								{bundle.width && bundle.height ? ` · ${bundle.width}×${bundle.height}` : ""}
								{" · "}<When iso={bundle.modifiedAt} />
							</p>
						</>
					)}
					<p className="text-muted-foreground text-sm" role="status">
						{errorDetail === null ? status : t("agentImport.failed")}
					</p>
					{errorDetail !== null && (
						<details className="text-muted-foreground break-words text-sm">
							<summary className="cursor-pointer">{t("common.errorDetails")}</summary>
							<p>{localizeErrorDetail(errorDetail, t)}</p>
						</details>
					)}
				</div>
				{!("error" in bundle) && (
					<Button className="shrink-0" disabled={busy} onClick={run}>
						{busy ? t("agentImport.busy") : t("home.importBundle")}
					</Button>
				)}
			</CardContent>
		</Card>
	);
}

function DraftCard({ draft }: { draft: InboxDraft }) {
	const { t } = useI18n();
	const projectId = "error" in draft ? null : draft.projectId;
	const projectName = useEditor((e) => (projectId ? e.project.getSavedProjects().find((p) => p.id === projectId)?.name ?? null : null));
	const listed = useEditor((e) => e.project.getIsInitialized() && !e.project.getIsLoading());
	if ("error" in draft) {
		return (
			<Card>
				<CardContent className="flex flex-col gap-1 p-4">
					<p className="text-muted-foreground text-xs font-medium">{t("home.draftKind")}</p>
					<p className="text-destructive break-words text-sm">{localizeErrorDetail(draft.error, t)}</p>
				</CardContent>
			</Card>
		);
	}
	const target = !draft.projectId
		? t("home.draftAnyProject")
		: projectName !== null
			? t("home.draftFor", { project: projectName })
			: listed
				? t("home.draftMissingProject", { id: draft.projectId })
				: null;
	return (
		<Card>
			<CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-muted-foreground text-xs font-medium">{t("home.draftKind")}</p>
					<h3 className="truncate font-medium">{draft.label ?? t("home.draftUntitled")}</h3>
					{target && <p className="text-sm">{target}</p>}
					<p className="text-muted-foreground text-sm">
						{t("home.draftDetails", { count: draft.ops })}{" · "}<When iso={draft.modifiedAt} />
					</p>
					<p className="text-muted-foreground text-sm">{t("home.draftApplies")}</p>
				</div>
				{projectName !== null && (
					<Button asChild className="shrink-0">
						<Link href={`/editor/${draft.projectId}`}>{t("home.openProject")}</Link>
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
