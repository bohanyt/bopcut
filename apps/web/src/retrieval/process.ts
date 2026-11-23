import { spawn } from "node:child_process";
import { checkCancelled } from "./jobs";

// The pipe is closed on cancellation and on owner exit, including a forced server stop.
// The supervisor stays outside the tool's process group so it can wait for termination.
const supervisor = String.raw `
	const { spawn } = require("node:child_process");
	const windows = process.platform === "win32";
	let tool;
	let input = "";
	let stopping = false;
	function stop() {
		if (stopping || !tool?.pid) return;
		stopping = true;
		if (windows) {
			const killer = spawn("taskkill.exe", ["/PID", String(tool.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			killer.once("error", () => tool.kill("SIGKILL"));
			killer.once("close", () => { if (tool.exitCode === null) tool.kill("SIGKILL"); });
			return;
		}
		try { process.kill(-tool.pid, "SIGKILL"); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		if (tool) return;
		input += chunk;
		if (!input.endsWith("\n")) return;
		const [command, args, scratch] = JSON.parse(input);
		const env = scratch ? { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } : process.env;
		tool = spawn(command, args, { env, detached: !windows, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
		tool.on("error", (error) => { console.error(error.message); process.exitCode = error.code === "ENOENT" ? 127 : 1; });
		tool.on("close", (code) => { process.exitCode ??= code ?? 1; process.stdin.destroy(); });
	});
	process.stdin.on("end", stop);
	process.stdin.on("error", stop);
`;

export async function runProcess(command: string, args: string[], signal?: AbortSignal, scratch?: string) {
	checkCancelled(signal, "tool startup");
	const child = spawn(process.execPath, ["-e", supervisor], {
		detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
	});
	const stop = () => child.stdin.end();
	signal?.addEventListener("abort", stop, { once: true });
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
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		child.stdin.write(JSON.stringify([command, args, scratch]) + "\n");
		const code = await exited;
		checkCancelled(signal, "tool execution");
		const errors = Buffer.concat(stderr).toString();
		if (size > 256 * 1024 * 1024) throw new Error("tool output exceeded its limit");
		if (code !== 0) throw Object.assign(new Error("tool exited with code " + code), { stderr: errors, code: code === 127 ? "ENOENT" : undefined });
		return { stdout: Buffer.concat(stdout).toString(), stderr: errors };
	} finally {
		signal?.removeEventListener("abort", stop);
	}
}
