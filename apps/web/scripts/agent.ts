import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs as parse } from "node:util";
import { fileInside } from "../src/agent/inside";

const commands = ["status", "selection", "notes", "prefs"] as const;
type Command = typeof commands[number];
const usage = "Use: bun run agent <status|selection|notes|prefs> [--project-id ID] [--timeout SECONDS]";

export function parseArgs(args: string[]) {
	const [command, ...rest] = args;
	if (!commands.some((supported) => supported === command)) throw new Error(usage);
	const { values } = parse({
		args: rest,
		options: { "project-id": { type: "string" }, timeout: { type: "string" }, url: { type: "string" } },
	});
	const seconds = Number(values.timeout ?? 30);
	if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86400) throw new Error("Set --timeout to a positive number of seconds, up to 86400.");
	const projectId = values["project-id"];
	if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("Pass a valid project ID to --project-id.");
	const url = URL.parse(values.url ?? process.env.BOPENCUT_URL ?? "http://127.0.0.1:3000");
	if (!url || !["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Set --url to the local editor origin, for example http://127.0.0.1:3000.");
	}
	return { command: command as Command, projectId, timeoutMs: Math.round(seconds * 1000), origin: url.origin };
}

const WEB_DIR = path.resolve(import.meta.dir, "..");

/** `KEY=value` lines of a dotenv file, as the editor server reads them (quotes, comments, `export`). */
export function parseEnvFile(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*("(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^#]*)/.exec(line);
		if (!match) continue;
		const raw = match[2].trim();
		values[match[1]] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
	}
	return values;
}

/**
 * Both preference files, read here rather than through the server, so private preferences are never
 * served over HTTP. Paths come from this process's environment, then `apps/web/.env.local`, as for the editor.
 */
export async function readPreferences(env: Record<string, string | undefined> = process.env, webDir = WEB_DIR) {
	let file: Record<string, string> = {};
	try { file = parseEnvFile(await fs.readFile(path.join(webDir, ".env.local"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const setting = (key: string) => env[key] || file[key] || undefined;
	const workspace = path.resolve(webDir, setting("AGENT_WORKSPACE") ?? path.join("..", "..", "workspace"));
	const general = setting("AGENT_PREFS");
	const read = async (root?: string) => {
		const found = root ? await fileInside(path.resolve(webDir, root), "PREFERENCES.md") : null;
		return found ? { missing: false, content: await fs.readFile(found, "utf8") } : { missing: true, content: null };
	};
	return { general: await read(general), workspace: await read(workspace) };
}

async function main(args: string[]) {
	const { command, projectId, timeoutMs, origin } = parseArgs(args);
	if (command === "prefs") return readPreferences();
	const target = new URL(`/api/agent/cli/${command}`, origin);
	if (projectId) target.searchParams.set("projectId", projectId);
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(target, { signal, redirect: "error" }).catch(() => {
			signal.throwIfAborted();
			throw new Error(`Cannot reach the editor at ${origin}. Start it from apps/web with bunx next dev --turbopack -H 127.0.0.1 -p ${target.port || "80"}, then retry.`);
		});
		const body = await response.json().catch(() => null);
		signal.throwIfAborted();
		if (!response.ok || !body) throw new Error(body?.error ?? "The server did not answer the agent CLI. Start this version of the editor and retry.");
		return body;
	} catch (error) {
		if (signal.aborted) throw new Error("Timed out while reading from the editor. Check the server or increase --timeout.");
		throw error;
	}
}

if (import.meta.main) {
	try {
		console.log(JSON.stringify(await main(process.argv.slice(2))));
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
		console.error(message);
		console.log(JSON.stringify({ error: message }));
		process.exitCode = 1;
	}
}
