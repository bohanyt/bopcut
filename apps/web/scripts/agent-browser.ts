import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "./retrieval-cli";

export type RunningBrowser = { exited: Promise<unknown>; stop(): Promise<void> };

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
		...["google-chrome", "microsoft-edge", "chromium", "chromium-browser"].map((name) => Bun.which(name) ?? ""),
	];
	const browser = candidates.find((file) => file && existsSync(file));
	if (!browser) throw new Error("No installed Chrome or Edge was found. Set BOPENCUT_BROWSER to its executable or open the project in the editor.");
	return browser;
}

function startBrowser(args: string[]): RunningBrowser {
	const windows = process.platform === "win32";
	const child = spawn(findBrowser(), args, { detached: !windows, windowsHide: true, stdio: "ignore" });
	const exited = new Promise<unknown>((resolve) => {
		child.once("error", resolve);
		child.once("exit", resolve);
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

export function launchBrowser(url: string, profile: string, { start = startBrowser, env = process.env }: {
	start?: typeof startBrowser;
	env?: Record<string, string | undefined>;
} = {}): RunningBrowser {
	if (env === process.env && env.BOPENCUT_RENDER_GPU === undefined) {
		loadEnvLocal(path.resolve(import.meta.dir, "../.env.local"), "BOPENCUT_RENDER_GPU");
	}
	const gpu = env.BOPENCUT_RENDER_GPU ?? "high-performance";
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
