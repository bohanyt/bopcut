import { spawn } from "node:child_process";
import type { Runner } from "./server";

export function jobRunner(signal: AbortSignal): Runner {
	return (command, args) => {
		signal.throwIfAborted();
		const windows = process.platform === "win32";
		const child = spawn(command, args, { detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stopping: Promise<void> | undefined;
		const stop = () => {
			const pid = child.pid;
			if (!pid || stopping) return;
			if (windows) {
				stopping = new Promise<void>((resolve) => {
					const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
					killer.once("error", () => { child.kill(); resolve(); });
					killer.once("exit", () => { child.kill(); resolve(); });
				});
			} else {
				try { process.kill(-pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
			}
		};
		let size = 0;
		let exceeded = false;
		const output = (chunks: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size <= 256 * 1024 * 1024) chunks.push(chunk);
			else { exceeded = true; stop(); }
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
				void Promise.resolve(stopping).then(() => {
					const detail = Buffer.concat(stderr).toString();
					if (signal.aborted) reject(signal.reason);
					else if (failure) reject(failure);
					else if (exceeded || code !== 0) reject(Object.assign(new Error(exceeded ? "Tool output exceeded its limit" : `Tool exited with code ${code}`), { stderr: detail }));
					else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: detail });
				});
			});
		});
	};
}
