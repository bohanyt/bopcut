import { spawn } from "node:child_process";
import type { Runner } from "./server";

// The pipe closes when the server exits, including when it cannot run a shutdown handler.
const supervisor = String.raw`
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
const windows = process.platform === "win32";
const tool = spawn(command, args, { detached: !windows, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let stopping;
function stop() {
	if (!tool.pid || stopping) return;
	if (windows) {
		stopping = new Promise((resolve) => {
			const killer = spawn("taskkill.exe", ["/PID", String(tool.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			const done = () => { tool.kill(); resolve(); };
			killer.once("error", done);
			killer.once("exit", done);
		});
	} else {
		stopping = Promise.resolve();
		try { process.kill(-tool.pid, "SIGKILL"); }
		catch (error) { if (error.code !== "ESRCH") tool.kill("SIGKILL"); }
	}
}
process.stdin.on("end", stop).on("error", stop).resume();
let failure;
tool.once("error", (error) => { failure = error; });
tool.once("close", async (code) => {
	await stopping;
	process.stdin.destroy();
	if (failure) console.error(failure.message);
	process.exitCode = failure?.code === "ENOENT" ? 127 : (code ?? 1);
});
`;

export function jobRunner(signal: AbortSignal): Runner {
	return (command, args) => {
		signal.throwIfAborted();
		const child = spawn(process.execPath, ["-e", supervisor, "--", command, ...args], {
			windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
		});
		const stop = () => child.stdin.end();
		child.stdin.on("error", () => {});
		let size = 0;
		let exceeded = false;
		const output = (chunks: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size <= 256 * 1024 * 1024) chunks.push(chunk);
			else if (!exceeded) { exceeded = true; stop(); }
		};
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", output(stdout));
		child.stderr.on("data", output(stderr));
		signal.addEventListener("abort", stop, { once: true });
		return new Promise((resolve, reject) => {
			let failure: Error | undefined;
			child.once("error", (error) => { failure = error; });
			child.once("close", (code) => {
				signal.removeEventListener("abort", stop);
				const detail = Buffer.concat(stderr).toString();
				if (signal.aborted) reject(signal.reason);
				else if (failure) reject(failure);
				else if (exceeded || code !== 0) reject(Object.assign(new Error(exceeded ? "Tool output exceeded its limit" : `Tool exited with code ${code}`), { stderr: detail, code: code === 127 ? "ENOENT" : undefined }));
				else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: detail });
			});
		});
	};
}
