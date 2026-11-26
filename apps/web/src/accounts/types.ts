// Shapes of /api/agent/accounts, shared with the home page's Accounts tab.

/** Browsers the video downloader (yt-dlp) can read cookies from. */
export const COOKIE_BROWSERS = ["firefox", "chrome", "edge", "brave", "chromium", "opera", "vivaldi", "whale", "safari"] as const;
export type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

export type Accounts = {
	/** The browser whose cookies the video downloader uses; null for none; missing to follow BOPENCUT_YTDLP_COOKIES_FROM_BROWSER. */
	cookiesFromBrowser?: CookieBrowser | null;
};

/** GET /api/agent/accounts. */
export type AccountsStatus = {
	cookies: {
		/** What downloads use now. */
		browser: string | null;
		/** Where that comes from: chosen in Accounts, BOPENCUT_YTDLP_COOKIES_FROM_BROWSER, or neither. */
		source: "accounts" | "env" | "none";
	};
};

/** POST /api/agent/accounts/test. */
export type CookieCheck =
	| { ok: true; browser: string; cookies: number; undecrypted: number }
	| { ok: false; error: string };
