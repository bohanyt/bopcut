"use client";

import { useCallback, useEffect, useState } from "react";
import type { Inbox } from "@/agent/inbox-types";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/editor/use-editor";
import { LanguageSwitch } from "@/i18n/language-switch";
import { useI18n } from "@/i18n/provider";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { AccountsTab } from "./accounts-tab";
import { AgentTab } from "./agent-tab";
import { NewProjectButton, ProjectsSearchBar, ProjectsTab, ProjectsViewModes } from "./projects-tab";

const TABS = ["projects", "agent", "accounts"] as const;
export type HomeTab = (typeof TABS)[number];

/** The tab a link asks for (`/?tab=agent`); Projects otherwise. */
export const tabFromSearch = (search: string): HomeTab => {
	const tab = new URLSearchParams(search).get("tab");
	return TABS.find((name) => name === tab) ?? "projects";
};

/** The agent's inbox, read when the page opens and when it is shown again (no polling). */
function useInbox() {
	const [inbox, setInbox] = useState<Inbox | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/agent/inbox", { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			setInbox(await response.json());
			setFailed(null);
		} catch (error) {
			setFailed(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
		void refresh();
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [refresh]);
	return { inbox, failed, refresh };
}

/** The first page: the person's projects, and what an agent made for them. */
export function HomePage() {
	const { t } = useI18n();
	const editor = useEditor();
	const [tab, setTab] = useState<HomeTab>("projects");
	const { inbox, failed, refresh } = useInbox();

	useEffect(() => setTab(tabFromSearch(window.location.search)), []);
	// Both tabs show projects: the agent's drafts are named after theirs.
	useEffect(() => {
		if (!editor.project.getIsInitialized()) void editor.project.loadAllProjects();
	}, [editor.project]);

	const select = (value: string) => {
		const next = tabFromSearch(`tab=${value}`);
		setTab(next);
		const url = new URL(window.location.href);
		if (next === "projects") url.searchParams.delete("tab");
		else url.searchParams.set("tab", next);
		window.history.replaceState(null, "", url);
	};
	const waiting = inbox ? Number(inbox.bundle !== null) + Number(inbox.draft !== null) : 0;
	const projects = tab === "projects";

	return (
		<div className="bg-background min-h-screen">
			<MigrationDialog />
			<ChangelogNotification />
			<Tabs value={tab} onValueChange={select}>
				<header className="sticky top-0 z-20 px-4 sm:px-8 bg-background flex flex-col gap-2">
					<div className="flex items-center justify-between gap-3 h-16 pt-2">
						<div className="flex min-w-0 items-center gap-3 md:gap-5">
							<TabsList aria-label={t("home.tabs")} className="min-w-0 overflow-x-auto">
								<TabsTrigger value="projects" className="h-9 px-3">{t("home.projectsTab")}</TabsTrigger>
								<TabsTrigger
									value="agent"
									className="h-9 gap-1.5 px-3"
									aria-label={waiting ? t("home.agentTabWaiting", { count: waiting }) : undefined}
								>
									{t("home.agentTab")}
									{waiting > 0 && (
										<span aria-hidden="true" className="bg-primary text-primary-foreground rounded-full px-1.5 text-xs leading-5">
											{waiting}
										</span>
									)}
								</TabsTrigger>
								<TabsTrigger value="accounts" className="h-9 px-3">{t("home.accountsTab")}</TabsTrigger>
							</TabsList>
							{projects && <ProjectsViewModes />}
						</div>
						<div className="flex shrink-0 items-center gap-3 md:gap-4">
							{projects && <ProjectsSearchBar className="hidden md:block" />}
							<LanguageSwitch />
							{projects && <NewProjectButton />}
						</div>
					</div>
					{projects && <ProjectsSearchBar className="block md:hidden mb-4" />}
				</header>
				{/* Both stay mounted: switching tabs keeps the list's scroll, selection and thumbnails. */}
				<TabsContent forceMount value="projects" hidden={tab !== "projects"}>
					<ProjectsTab />
				</TabsContent>
				<TabsContent forceMount value="agent" hidden={tab !== "agent"}>
					<AgentTab inbox={inbox} failed={failed} onRetry={() => void refresh()} />
				</TabsContent>
				<TabsContent forceMount value="accounts" hidden={tab !== "accounts"}>
					<AccountsTab active={tab === "accounts"} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
