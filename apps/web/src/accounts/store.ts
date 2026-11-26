// Services bopencut uses, chosen on the home page's Accounts tab. They are kept in the data folder
// (BOPENCUT_DATA/accounts.json), next to the projects, and read by the server only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite, dataRoot } from "@/services/storage/server/files";
import { COOKIE_BROWSERS, type Accounts } from "./types";

const accountsFile = () => path.join(dataRoot(), "accounts.json");

function clean(data: unknown): Accounts {
	const accounts: Accounts = {};
	const browser = (data as Accounts | null)?.cookiesFromBrowser;
	if (browser === null || (typeof browser === "string" && (COOKIE_BROWSERS as readonly string[]).includes(browser))) {
		accounts.cookiesFromBrowser = browser;
	}
	return accounts;
}

/** Read on each use (it is a small file), so a choice applies to the next download without a restart. */
export function readAccounts(): Accounts {
	try {
		return clean(JSON.parse(readFileSync(accountsFile(), "utf8")));
	} catch {
		return {};
	}
}

export async function saveAccounts(change: Accounts): Promise<Accounts> {
	const next = clean({ ...readAccounts(), ...change });
	await atomicWrite(accountsFile(), JSON.stringify(next, null, 1));
	return next;
}

/**
 * The browser the video downloader reads cookies from: the one chosen in Accounts, otherwise
 * BOPENCUT_YTDLP_COOKIES_FROM_BROWSER. An environment passed in explicitly (tests, tools) is used as it is.
 */
export function cookiesFromBrowser(env: Record<string, string | undefined> = process.env): string | undefined {
	const configured = env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER?.trim() || undefined;
	if (env !== process.env) return configured;
	const chosen = readAccounts().cookiesFromBrowser;
	return chosen === undefined ? configured : chosen ?? undefined;
}
