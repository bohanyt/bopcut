import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** How the browser process ended: its exit code or signal, or why it could not start, and when. */
export type BrowserExit = { code?: number | null; signal?: string | null; error?: string; afterMs: number };
export type RunningBrowser = { exited: Promise<BrowserExit | void>; stop(): Promise<void> };

/** The first file of that name in a PATH folder. The editor server runs without Bun's own lookup. */
function onPath(name: string) {
	for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
		const file = folder && path.join(folder, name);
		if (file && existsSync(file)) return file;
	}
	return "";
}

function findBrowser() {
	const configured = process.env.BOPENCUT_BROWSER;
	const programs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((value): value is string => !!value);
	const windows = programs.flatMap((root) => [
		path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
		path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
	]);
	const candidates = configured ? [configured] : process.platform === "win32" ? windows : [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		...["google-chrome", "microsoft-edge", "chromium", "chromium-browser"].map(onPath),
	];
	const browser = candidates.find((file) => file && existsSync(file));
	if (!browser) throw new Error("No installed Chrome or Edge was found. Set BOPENCUT_BROWSER to its executable or open the project in the editor.");
	return browser;
}

function startBrowser(args: string[]): RunningBrowser {
	const windows = process.platform === "win32";
	const child = spawn(findBrowser(), args, { detached: !windows, windowsHide: true, stdio: "ignore" });
	const started = Date.now();
	const exited = new Promise<BrowserExit>((resolve) => {
		child.once("error", (error) => resolve({ error: error.message, afterMs: Date.now() - started }));
		child.once("exit", (code, signal) => resolve({ code, signal, afterMs: Date.now() - started }));
	});
	return {
		exited,
		async stop() {
			const pid = child.pid;
			if (!pid) { await exited; return; }
			if (windows) {
				const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
				await new Promise<void>((resolve) => {
					killer.once("error", () => resolve());
					killer.once("exit", () => resolve());
				});
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			} else {
				try { process.kill(-pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
			await exited;
		},
	};
}

/**
 * Starts the hidden browser that renders for the agent CLI and the MCP server. The CLI passes its
 * `.env.local` as envFile; the editor server has already loaded that file into its environment.
 */
export function launchBrowser(url: string, profile: string, {
	start = startBrowser,
	env = process.env,
	envFile,
}: {
	start?: typeof startBrowser;
	env?: Record<string, string | undefined>;
	envFile?: string;
} = {}): RunningBrowser {
	let gpu = env.BOPENCUT_RENDER_GPU;
	if (gpu === undefined && envFile && existsSync(envFile)) {
		gpu = parseEnv(readFileSync(envFile, "utf8")).BOPENCUT_RENDER_GPU;
	}
	gpu ??= "high-performance";
	if (gpu !== "high-performance" && gpu !== "low-power") {
		throw new Error("Set BOPENCUT_RENDER_GPU to high-performance or low-power.");
	}
	return start([
		"--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
		"--disable-breakpad", "--disable-crash-reporter", "--disable-extensions", "--disable-sync",
		"--disable-background-timer-throttling", "--disable-renderer-backgrounding",
		...(gpu === "high-performance" ? ["--force_high_performance_gpu"] : []),
		"--enable-unsafe-swiftshader", `--user-data-dir=${profile}`, url,
	]);
}
