"use client";
import { Button } from "@/components/ui/button";
import { Section, SectionContent, SectionHeader, SectionTitle } from "@/components/section";
import { useI18n } from "@/i18n/provider";
import { useProxyStore } from "@/services/proxies/client";

export function ProxySettings() {
	const { t } = useI18n();
	const { settings, update, save, clear } = useProxyStore();
	const enabled = settings.enabled ?? (update?.state === "ready" || update?.state === "preparing" ||
		update?.state === "disk" || update?.state === "readonly");
	const status = update?.state ?? "off";
	return (
		<Section showTopBorder={false}>
			<SectionHeader><SectionTitle>{t("proxies.title")}</SectionTitle></SectionHeader>
			<SectionContent className="flex flex-col gap-2 px-2 pb-2">
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" role="switch" checked={enabled} onChange={event => save({ ...settings, enabled: event.currentTarget.checked, retry: Date.now() })} />
					{t("proxies.title")}
				</label>
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" checked={settings.software} onChange={event => save({ ...settings, software: event.currentTarget.checked })} />
					{t("proxies.softwareEncoder")}
				</label>
				<p className="text-sm" role="status">{status === "preparing"
					? t("proxies.preparing", { done: update?.done ?? 0, total: update?.total ?? 0 })
					: t(`proxies.${status}`)}</p>
				{update?.error && <p className="text-muted-foreground text-xs break-words">{update.error}</p>}
				{(status === "missing" || status === "failed" || status === "software") && (
					<Button variant="outline" size="sm" onClick={() => save({ ...settings, enabled: true, retry: Date.now() })}>{t("common.retry")}</Button>
				)}
				<p className="text-sm">{t("proxies.diskUsage", { size: ((update?.bytes ?? 0) / 1_000_000).toFixed(1) })}</p>
				<Button variant="outline" size="sm" disabled={status === "readonly"} onClick={() => { void clear().catch(() => {}); }}>{t("proxies.deleteAll")}</Button>
			</SectionContent>
		</Section>
	);
}
