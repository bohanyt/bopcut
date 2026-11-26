"use client";

import { useEffect, useState } from "react";
import { type AccountsStatus, COOKIE_BROWSERS, type CookieBrowser, type CookieCheck } from "@/accounts/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { localizeErrorDetail } from "@/i18n/error-details";
import { useI18n } from "@/i18n/provider";

const BROWSER_NAMES: Record<CookieBrowser, string> = {
	firefox: "Firefox", chrome: "Chrome", edge: "Edge", brave: "Brave", chromium: "Chromium",
	opera: "Opera", vivaldi: "Vivaldi", whale: "Whale", safari: "Safari",
};
const browserName = (browser: string) => BROWSER_NAMES[browser as CookieBrowser] ?? browser;
/** The select's value while the browser comes from .env.local. */
const FROM_ENV = "env";

async function request<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, body === undefined
		? { cache: "no-store" }
		: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const data = await response.json().catch(() => null);
	if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
	return data as T;
}

/** Services bopencut uses, connected once instead of in `.env.local`. Read the first time the tab is shown. */
export function AccountsTab({ active }: { active: boolean }) {
	const { t } = useI18n();
	const [status, setStatus] = useState<AccountsStatus | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	const load = () => {
		setLoaded(true);
		request<AccountsStatus>("/api/agent/accounts").then((next) => {
			setStatus(next);
			setFailed(null);
		}, (error) => setFailed(error instanceof Error ? error.message : String(error)));
	};
	useEffect(() => {
		if (active && !loaded) load();
	});

	if (failed !== null && !status) {
		return (
			<main role="alert" className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
				<h3 className="text-lg font-medium">{t("accounts.failed")}</h3>
				<details className="text-muted-foreground max-w-md break-words text-xs">
					<summary className="cursor-pointer">{t("common.errorDetails")}</summary>
					<p>{localizeErrorDetail(failed, t)}</p>
				</details>
				<Button onClick={load}>{t("common.retry")}</Button>
			</main>
		);
	}
	if (!status) return <main className="text-muted-foreground mx-auto max-w-3xl px-4 py-16 text-center text-sm" role="status">{t("accounts.loading")}</main>;
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-4 pb-6 sm:px-8">
			<CookieBrowserCard status={status} onChange={setStatus} />
		</main>
	);
}

function CookieBrowserCard({ status, onChange }: { status: AccountsStatus; onChange: (status: AccountsStatus) => void }) {
	const { t } = useI18n();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [check, setCheck] = useState<CookieCheck | null>(null);
	const { browser, source } = status.cookies;

	const choose = async (value: string) => {
		if (value === FROM_ENV) return;
		setSaving(true);
		setSaveError(null);
		setCheck(null);
		try {
			onChange(await request<AccountsStatus>("/api/agent/accounts", { cookiesFromBrowser: value || null }));
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	const test = async () => {
		setChecking(true);
		setCheck(null);
		try {
			setCheck(await request<CookieCheck>("/api/agent/accounts/test", {}));
		} catch (error) {
			setCheck({ ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			setChecking(false);
		}
	};

	return (
		<Card>
			<CardContent className="flex flex-col gap-3 p-4">
				<div className="flex flex-col gap-1">
					<h3 className="font-medium">{t("accounts.cookiesTitle")}</h3>
					<p className="text-muted-foreground text-sm">{t("accounts.cookiesDescription")}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<select
						aria-label={t("accounts.cookiesBrowser")}
						className="bg-background h-9 min-w-48 rounded border px-2 text-sm"
						value={source === "env" ? FROM_ENV : browser ?? ""}
						disabled={saving}
						onChange={(event) => void choose(event.target.value)}
					>
						{source === "env" && browser && <option value={FROM_ENV}>{t("accounts.fromEnv", { browser: browserName(browser) })}</option>}
						<option value="">{t("accounts.noBrowser")}</option>
						{COOKIE_BROWSERS.map((name) => (
							<option key={name} value={name}>{BROWSER_NAMES[name]}</option>
						))}
					</select>
					<Button variant="outline" className="h-9" disabled={checking || saving || !browser} onClick={() => void test()}>
						{checking ? t("accounts.testing") : t("accounts.test")}
					</Button>
				</div>
				{saveError !== null && (
					<p role="alert" className="text-destructive break-words text-sm">
						{t("accounts.saveFailed")}: {localizeErrorDetail(saveError, t)}
					</p>
				)}
				<CheckResult check={check} />
				<p className="text-muted-foreground text-xs">{t("accounts.cookiesWindows")}</p>
			</CardContent>
		</Card>
	);
}

function CheckResult({ check }: { check: CookieCheck | null }) {
	const { t } = useI18n();
	// One live region, so a screen reader hears each result.
	return (
		<div role="status" className="flex flex-col gap-1 text-sm">
			{check && !check.ok && (
				<>
					<p className="text-destructive">{t("accounts.cookiesFailed")}</p>
					<p className="text-muted-foreground break-words text-xs">{localizeErrorDetail(check.error, t)}</p>
				</>
			)}
			{check?.ok && (
				<p>
					{check.cookies > 0
						? t("accounts.cookiesRead", { count: check.cookies, browser: browserName(check.browser) })
						: t("accounts.cookiesNone", { browser: browserName(check.browser) })}
					{check.undecrypted > 0 && <> {t("accounts.cookiesUndecrypted", { count: check.undecrypted })}</>}
				</p>
			)}
		</div>
	);
}
