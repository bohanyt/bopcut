// /api/agent/accounts: the home page's Accounts tab (local only, like the rest of the agent API).
//   GET              what downloads use now
//   POST             {cookiesFromBrowser: "firefox" | ... | null} chooses the cookie browser (null: none)
//   POST test        {browser?} checks that yt-dlp can read that browser's cookies (default: the one in use)
import { readTextLimited } from "@/agent/export-server";
import { checkCookies } from "./cookie-check";
import { readAccounts, saveAccounts } from "./store";
import { type AccountsStatus, COOKIE_BROWSERS, type CookieBrowser } from "./types";

const isBrowser = (value: unknown): value is CookieBrowser => typeof value === "string" && (COOKIE_BROWSERS as readonly string[]).includes(value);

export function accountsStatus(env: Record<string, string | undefined> = process.env): AccountsStatus {
	const chosen = readAccounts().cookiesFromBrowser;
	if (chosen !== undefined) return { cookies: { browser: chosen, source: "accounts" } };
	const configured = env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER?.trim() || null;
	return { cookies: { browser: configured, source: configured ? "env" : "none" } };
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
	const text = await readTextLimited(req, 4096);
	try {
		const value = text === null ? null : JSON.parse(text || "{}");
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

export async function handleAccounts(req: Request, action: string | undefined, filesRoot: string): Promise<Response> {
	const noStore = { headers: { "Cache-Control": "no-store" } };
	if (req.method === "GET" && action === undefined) return Response.json(accountsStatus(), noStore);
	if (req.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
	const input = await body(req);
	if (!input) return Response.json({ error: "Send a JSON object." }, { status: 400 });
	if (action === undefined) {
		const browser = input.cookiesFromBrowser;
		if (browser !== null && !isBrowser(browser)) {
			return Response.json({ error: `cookiesFromBrowser is one of ${COOKIE_BROWSERS.join(", ")}, or null for none.` }, { status: 400 });
		}
		await saveAccounts({ cookiesFromBrowser: browser });
		return Response.json(accountsStatus(), noStore);
	}
	if (action === "test") {
		const browser = input.browser ?? accountsStatus().cookies.browser;
		if (browser === null) return Response.json({ error: "Choose a browser first." }, { status: 400 });
		// A setting from .env.local may name a profile too (firefox:work); one sent here is a plain name.
		if (input.browser !== undefined && !isBrowser(browser)) return Response.json({ error: `browser is one of ${COOKIE_BROWSERS.join(", ")}.` }, { status: 400 });
		return Response.json(await checkCookies(String(browser), { signal: req.signal, filesRoot }), noStore);
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}
