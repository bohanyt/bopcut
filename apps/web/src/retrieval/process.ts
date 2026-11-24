import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { checkCancelled, withScratch } from "./jobs";
import { windowsSupervisor, windowsWorker } from "./process-windows";
import { RetrievalError } from "./server-errors";
import { cookiePlugin, cookiePluginFile, runWithPrivateCookies } from "./yt-dlp-cookies";

// The pipe is closed on cancellation and on owner exit, including a forced server stop.
// The supervisor stays outside the tool's process group so it can wait for termination.
const unixSupervisor = String.raw `
	const { execFile, spawn } = require("node:child_process");
	if (process.env.BOPENCUT_TOOL_BACKGROUND === "1") require("node:os").setPriority(0, 10);
	let tool;
	let input = "";
	let stopping = false;
	function stop() {
		if (stopping) return;
		stopping = true;
		if (!tool?.pid) return;
		try { process.kill(-tool.pid, "SIGKILL"); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	function finish(code) {
		process.exitCode ??= code ?? 1;
		process.stdin.destroy();
	}
	function waitForGroup(code) {
		if (!tool.pid) return finish(code);
		try { process.kill(-tool.pid, 0); }
		catch (error) {
			if (error.code === "ESRCH") return finish(code);
			throw error;
		}
		// A container's init may leave orphaned zombies in the group after they have exited.
		execFile("/bin/ps", ["-A", "-o", "pgid=", "-o", "stat="], { timeout: 1000 }, (error, stdout) => {
			if (error) {
				stop();
				console.error("could not inspect the tool process group");
				return finish(1);
			}
			const running = stdout.trim().split("\n").some((line) => {
				const [group, state] = line.trim().split(/\s+/);
				return Number(group) === tool.pid && !state.startsWith("Z");
			});
			if (running) setTimeout(() => waitForGroup(code), 50);
			else finish(code);
		});
	}
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		if (tool || stopping) return;
		input += chunk;
		if (!input.endsWith("\n")) return;
	const [command, args] = JSON.parse(input);
	const low = process.env.BOPENCUT_TOOL_LOW_PRIORITY === "1";
	tool = spawn(low ? "nice" : command, low ? ["-n", "5", command, ...args] : args,
		{ detached: true, stdio: ["ignore", "inherit", "inherit"] });
		tool.once("error", (error) => { console.error(error.message); finish(error.code === "ENOENT" ? 127 : 1); });
		tool.once("exit", waitForGroup);
	});
	process.stdin.on("end", stop);
	process.stdin.on("error", stop);
`;

export function runProcess(command: string, args: string[], signal?: AbortSignal, filesRoot?: string, options?: { lowPriority?: boolean }) {
	return withToolScratch(signal, filesRoot, (temp, activeSignal) => supervise(command, args, activeSignal, temp,
		options?.lowPriority ? { BOPENCUT_TOOL_LOW_PRIORITY: "1" } : undefined));
}

export function runBackgroundProcess(command: string, args: string[], signal: AbortSignal, filesRoot: string) {
	return withToolScratch(signal, filesRoot, (temp, activeSignal) =>
		supervise(command, args, activeSignal, temp, { BOPENCUT_TOOL_BACKGROUND: "1" }));
}

export function runYtDlpProcess(command: string, args: string[], signal?: AbortSignal, filesRoot?: string, workspace?: string) {
	return withToolScratch(signal, filesRoot, async (temp, activeSignal) => {
		const env: Record<string, string> = {
			YTDLP_NO_PLUGINS: "",
			BOPENCUT_TOOL_ORIGINAL_TEMP: JSON.stringify({
				TMPDIR: process.env.TMPDIR ?? null, TMP: process.env.TMP ?? null, TEMP: process.env.TEMP ?? null,
			}),
		};
		if (process.platform === "win32") {
			env.BOPENCUT_TOOL_PLUGIN_FILE = cookiePluginFile;
			env.BOPENCUT_TOOL_PLUGIN_SOURCE = cookiePlugin;
		} else {
			const file = path.join(temp, cookiePluginFile);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, cookiePlugin, { flag: "wx" });
		}
		return runWithPrivateCookies(args, temp, activeSignal,
			(toolArgs) => supervise(command, toolArgs, activeSignal, temp, env));
	}, workspace);
}

// Tool scratch holds private copies (such as cookies), so it must lie outside the files root, which is served.
export async function withToolScratch<T>(
	signal: AbortSignal | undefined, filesRoot: string | undefined,
	work: (temp: string, signal: AbortSignal) => Promise<T>,
	workspace?: string,
): Promise<T> {
	const assets = path.resolve(filesRoot ?? process.env.AGENT_FILES_ROOT ??
		process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "..", "..", "workspace"));
	const roots = await Promise.all([assets, ...(workspace ? [path.resolve(workspace)] : [])]
		.map((root) => fs.realpath(root).catch(() => root)));
	const uid = process.getuid?.();
	for (const base of [tmpdir(), homedir()]) {
		const real = await fs.realpath(base).catch(() => path.resolve(base));
		const privateRoot = path.join(real, ".bopencut-tool-jobs" + (uid === undefined ? "" : "-" + uid));
		if (roots.some((root) => {
			const relative = path.relative(root, privateRoot);
			return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
		})) continue;
		const stat = await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 })
			.then(() => fs.lstat(privateRoot)).catch(() => undefined);
		if (!stat?.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) continue;
		return withScratch(privateRoot, signal, work);
	}
	throw new RetrievalError("no private tool temp folder is available outside the files root");
}

async function supervise(command: string, args: string[], signal: AbortSignal, scratch: string, extraEnv?: Record<string, string>) {
	checkCancelled(signal, "tool startup");
	const env = { ...process.env, ...extraEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
	const options = { windowsHide: true, stdio: "pipe" as const };
	const child = process.platform === "win32"
		? spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsSupervisor, "utf16le").toString("base64")],
			{ ...options, env: { ...env, BOPENCUT_TOOL_EXECUTABLE: process.execPath, BOPENCUT_TOOL_WORKER: windowsWorker } })
		: spawn(process.execPath, ["-e", unixSupervisor], { ...options, env, detached: true });
	const stop = () => child.stdin.end();
	signal.addEventListener("abort", stop, { once: true });
	try {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		const append = (chunks: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size > 256 * 1024 * 1024) stop();
			else chunks.push(chunk);
		};
		child.stdout.on("data", append(stdout));
		child.stderr.on("data", append(stderr));
		child.stdin.on("error", () => {}); // The supervisor may exit while the command is being sent.
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		child.stdin.write(JSON.stringify([command, args]) + "\n");
		const code = await exited;
		// An inherited writer outside the supervised tree must not hold this job open.
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			closed.then(() => true),
			new Promise<false>((resolve) => { drainTimer = setTimeout(() => resolve(false), 1000); }),
		]);
		clearTimeout(drainTimer);
		if (!drained) {
			child.stdout.destroy();
			child.stderr.destroy();
		}
		checkCancelled(signal, "tool execution");
		if (!drained) throw new Error("tool output pipes did not close");
		const errors = Buffer.concat(stderr).toString();
		if (size > 256 * 1024 * 1024) throw new Error("tool output exceeded its limit");
		if (code !== 0) throw Object.assign(new Error("tool exited with code " + code), { stderr: errors, code: code === 127 ? "ENOENT" : undefined });
		return { stdout: Buffer.concat(stdout).toString(), stderr: errors };
	} finally {
		signal.removeEventListener("abort", stop);
	}
}
