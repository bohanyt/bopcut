"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { useI18n } from "@/i18n/provider";
import { Separator } from "@/components/ui/separator";
import { type Tab, useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { MediaView } from "./views/assets";

const deferPanel = (load: () => Promise<ComponentType>) =>
	dynamic(() => load().then((view) => ({ default: view })), { ssr: false });

const SoundsView = deferPanel(() => import("@/sounds/components/assets-view").then((m) => m.SoundsView));
const TextView = deferPanel(() => import("@/text/components/assets-view").then((m) => m.TextView));
const StickersView = deferPanel(() => import("@/stickers/components/assets-view").then((m) => m.StickersView));
const EffectsView = deferPanel(() => import("@/effects/components/assets-view").then((m) => m.EffectsView));
const Captions = deferPanel(() => import("@/subtitles/components/assets-view").then((m) => m.Captions));
const SettingsView = deferPanel(() => import("./views/settings").then((m) => m.SettingsView));

export function AssetsPanel() {
	const { t } = useI18n();
	const { activeTab } = useAssetsPanelStore();

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: <EffectsView />,
		transitions: (
			<div className="text-muted-foreground p-4">
				{t("assets.transitionsComing")}
			</div>
		),
		captions: <Captions />,
		adjustment: (
			<div className="text-muted-foreground p-4">
				{t("assets.adjustmentComing")}
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
