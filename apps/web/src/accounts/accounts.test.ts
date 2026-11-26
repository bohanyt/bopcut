import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolsFromEnv } from "@/retrieval/server";
import { OFFLINE_LINK, checkCookies } from "./cookie-check";
import { handleAccounts } from "./server";
import { cookiesFromBrowser, readAccounts, saveAccounts } from "./store";

let dir: string;
const saved = { data: process.env.BOPENCUT_DATA, cookies: process.env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER };
const restore = (key: string, value: string | undefined) => {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-"));
	process.env.BOPENCUT_DATA = dir;
	delete process.env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER;
});
afterEach(async () => {
	restore("BOPENCUT_DATA", saved.data);
	restore("BOPENCUT_YTDLP_COOKIES_FROM_BROWSER", saved.cookies);
	await fs.rm(dir, { recursive: true, force: true });
});

const call = (method: string, action?: string, body?: unknown) =>
	handleAccounts(new Request("http://127.0.0.1:3000/api/agent/accounts", { method, body: body === undefined ? undefined : JSON.stringify(body) }), action, dir);

test("a browser chosen in Accounts comes before .env.local, and none turns cookies off", async () => {
	process.env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER = "chrome";
	expect(cookiesFromBrowser()).toBe("chrome");
	expect(await (await call("GET")).json()).toEqual({ cookies: { browser: "chrome", source: "env" } });

	expect(await (await call("POST", undefined, { cookiesFromBrowser: "firefox" })).json()).toEqual({ cookies: { browser: "firefox", source: "accounts" } });
	expect(JSON.parse(await fs.readFile(path.join(dir, "accounts.json"), "utf8"))).toEqual({ cookiesFromBrowser: "firefox" });
	// Downloads use it at once, with no restart.
	expect(toolsFromEnv().cookiesFromBrowser).toBe("firefox");

	expect(await (await call("POST", undefined, { cookiesFromBrowser: null })).json()).toEqual({ cookies: { browser: null, source: "accounts" } });
	expect(toolsFromEnv().cookiesFromBrowser).toBeUndefined();
	// An environment passed in explicitly is used as it is.
	expect(toolsFromEnv({ BOPENCUT_YTDLP_COOKIES_FROM_BROWSER: "edge" }).cookiesFromBrowser).toBe("edge");
});

test("only a known browser or none is saved, and a damaged file counts as no choice", async () => {
	for (const body of [{ cookiesFromBrowser: "firefox:work" }, { cookiesFromBrowser: "netscape" }, {}, [1]]) {
		expect((await call("POST", undefined, body)).status).toBe(400);
	}
	expect((await call("POST", undefined, "not json")).status).toBe(400);
	expect(await fs.readdir(dir)).toEqual([]);
	await fs.writeFile(path.join(dir, "accounts.json"), JSON.stringify({ cookiesFromBrowser: "--exec rm" }));
	expect(readAccounts()).toEqual({});
	await fs.writeFile(path.join(dir, "accounts.json"), "{");
	expect(readAccounts()).toEqual({});
	expect(await saveAccounts({ cookiesFromBrowser: "brave" })).toEqual({ cookiesFromBrowser: "brave" });
	expect((await call("GET", "test")).status).toBe(404);
});

test("a test needs a browser, and only a known one", async () => {
	expect(await (await call("POST", "test", {})).json()).toEqual({ error: "Choose a browser first." });
	expect((await call("POST", "test", { browser: "firefox --exec x" })).status).toBe(400);
});

/** A stand-in for yt-dlp run like the real one: it says what it read, then refuses the offline link. */
async function fakeYtDlp(stdout: string, stderr: string) {
	const script = path.join(dir, "fake-yt-dlp.cjs");
	await fs.writeFile(script, `
		const fs = require("node:fs"), path = require("node:path");
		fs.writeFileSync(path.join(${JSON.stringify(dir)}, "args.json"), JSON.stringify(process.argv.slice(2)));
		// What bopencut's cookie plugin reports when no cookie file is configured.
		fs.writeFileSync(path.join(process.env.TMPDIR, "cookie-state"), "none");
		process.stdout.write(${JSON.stringify(stdout)});
		process.stderr.write(${JSON.stringify(stderr)});
		process.exit(1);
	`);
	return [process.execPath, script];
}

test("the check reads what yt-dlp printed before the offline link failed, and never goes online", async () => {
	const files = path.join(dir, "files");
	await fs.mkdir(files);
	const ytdlp = await fakeYtDlp(
		"[generic] Extracting URL: file:///bopencut-cookie-check\nExtracting cookies from chrome\nExtracted 12 cookies from chrome (3 could not be decrypted)\n",
		"ERROR: file:// URLs are disabled by default in yt-dlp for security reasons.\n",
	);
	expect(await checkCookies("chrome", { ytdlp, filesRoot: files })).toEqual({ ok: true, browser: "chrome", cookies: 12, undecrypted: 3 });
	const args: string[] = JSON.parse(await fs.readFile(path.join(dir, "args.json"), "utf8"));
	expect(args.slice(args.indexOf("--cookies-from-browser"), args.indexOf("--cookies-from-browser") + 2)).toEqual(["--cookies-from-browser", "chrome"]);
	expect(args.at(-1)).toBe(OFFLINE_LINK);
	expect(args.filter((arg) => /^https?:/.test(arg))).toEqual([]);

	const failing = await fakeYtDlp("Extracting cookies from firefox\n", "[debug] Cookie: secret=1\nERROR: could not find firefox cookies database in '/home/me/.mozilla'\n");
	expect(await checkCookies("firefox", { ytdlp: failing, filesRoot: files })).toEqual({ ok: false, error: "could not find firefox cookies database in '/home/me/.mozilla'" });
}, 20_000);

test("a missing yt-dlp or a cancelled check says so", async () => {
	expect(await checkCookies("firefox", { ytdlp: ["no-such-yt-dlp"], run: async () => { throw Object.assign(new Error("spawn"), { code: "ENOENT" }); } }))
		.toEqual({ ok: false, error: expect.stringContaining("yt-dlp was not found") });
	const controller = new AbortController();
	controller.abort();
	expect(await checkCookies("firefox", { ytdlp: ["yt-dlp"], signal: controller.signal, run: async () => { throw new Error("stopped"); } }))
		.toEqual({ ok: false, error: "The check was cancelled." });
	expect(await checkCookies("firefox", { ytdlp: ["yt-dlp"], run: async () => ({ stdout: "", stderr: "" }) }))
		.toEqual({ ok: false, error: "yt-dlp did not read any cookies from this browser." });
});
