// The Accounts tab's test of a cookie browser: can the video downloader read its cookies?
import { runYtDlpProcess } from "@/retrieval/process";
import { type Runner, toolsFromEnv, ytDlpJobArgs } from "@/retrieval/server";
import type { CookieCheck } from "./types";

/** yt-dlp reads the cookies, then refuses this link without opening it: the check never goes online. */
export const OFFLINE_LINK = "file:///bopencut-cookie-check";
const CHECK_SECONDS = 60;

export async function checkCookies(
	browser: string,
	deps: { ytdlp?: string[]; run?: Runner; signal?: AbortSignal; filesRoot?: string } = {},
): Promise<CookieCheck> {
	const [command, ...leading] = deps.ytdlp ?? toolsFromEnv().ytdlp;
	const run = deps.run ?? runYtDlpProcess;
	const signal = AbortSignal.any([AbortSignal.timeout(CHECK_SECONDS * 1000), ...(deps.signal ? [deps.signal] : [])]);
	const args = [...leading, ...ytDlpJobArgs(), "--simulate", "--no-playlist", "--cookies-from-browser", browser, "--", OFFLINE_LINK];
	let stdout = "";
	let stderr = "";
	try {
		({ stdout, stderr } = await run(command, args, signal, deps.filesRoot));
	} catch (error) {
		const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		if (e.code === "ENOENT") return { ok: false, error: "yt-dlp was not found. Install it or set BOPENCUT_YTDLP (for example `python -m yt_dlp`)." };
		if (signal.aborted) {
			return { ok: false, error: deps.signal?.aborted ? "The check was cancelled." : `yt-dlp did not read the cookies within ${CHECK_SECONDS} s.` };
		}
		// The link always fails; what matters is whether the cookies were read before it.
		stdout = e.stdout ?? "";
		stderr = e.stderr ?? e.message ?? "";
	}
	const read = /Extracted (\d+) cookies from (\S+)(?: \((\d+) could not be decrypted\))?/.exec(stdout);
	if (read) return { ok: true, browser: read[2], cookies: Number(read[1]), undecrypted: Number(read[3] ?? 0) };
	// Only the error lines: debug output from the person's yt-dlp config is not shown.
	const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^ERROR:|\berror:/.test(line));
	const error = lines.at(-1)?.replace(/^ERROR:\s*|^\S+: error:\s*/, "");
	return { ok: false, error: error || "yt-dlp did not read any cookies from this browser." };
}
