import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RetrievalError } from "./server-errors";

// The supervisor is detached, so it outlives a forced server stop: the pipe closes then, and taskkill
// ends the tool with the processes it started. The tool itself also ends if the supervisor is killed.
export const windowsSupervisor = String.raw`
	const { spawn } = require("node:child_process");
	const { join } = require("node:path");
	if (process.env.BOPENCUT_TOOL_BACKGROUND === "1" || process.env.BOPENCUT_TOOL_LOW_PRIORITY === "1") {
		require("node:os").setPriority(0, 10);
	}
	let tool;
	let input = "";
	let stopping = false;
	function stop() {
		if (stopping) return;
		stopping = true;
		if (!tool?.pid || tool.exitCode !== null) return;
		const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		const killer = spawn(taskkill, ["/PID", String(tool.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.once("error", () => tool.kill());
		killer.once("exit", (code) => { if (code !== 0) tool.kill(); });
	}
	function finish(code) {
		process.exitCode ??= code ?? 1;
		process.stdin.destroy();
	}
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		if (tool || stopping) return;
		input += chunk;
		if (!input.endsWith("\n")) return;
		const [command, args] = JSON.parse(input);
		tool = spawn(command, args, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
		tool.once("error", (error) => { console.error(error.message); finish(error.code === "ENOENT" ? 127 : 1); });
		tool.once("exit", finish);
	});
	process.stdin.on("end", stop);
	process.stdin.on("error", stop);
`;

/** Leaves only the current user in the folder's access list. POSIX mode bits are ignored on Windows. */
export async function protectDirectory(directory: string) {
	const { username } = userInfo();
	const user = process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" + username : username;
	const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
	try {
		await promisify(execFile)(icacls, [directory, "/inheritance:r", "/grant:r", user + ":(OI)(CI)F"], { windowsHide: true, timeout: 10_000 });
	} catch {
		throw new RetrievalError("the tool scratch folder could not be protected for the current user");
	}
}
