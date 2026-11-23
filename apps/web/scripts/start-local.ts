import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { assignment, envValues } from "./local-env";
import { commandFromSetting } from "../src/retrieval/server";

const USAGE = "bun run start:local [--footage <dir>] [--data <dir>] [--port <number>] [--yes]";
const SETUP_COMMENT = "# Local bopencut paths are optional. See AGENT.md.";
const folderSettings = [
	{ key: "AGENT_FILES_ROOT", option: "footage", label: "Footage folder" },
	{ key: "BOPENCUT_DATA", option: "data", label: "Data folder (optional)" },
] as const;

type FolderKey = typeof folderSettings[number]["key"];
type FolderValues = Partial<Record<FolderKey, string>>;
type Options = {
	footage?: string;
	data?: string;
	port: number;
	yes: boolean;
	help: boolean;
};

export function parseArgs(args: string[]): Options {
	const options: Options = { port: 3000, yes: false, help: false };
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--yes") options.yes = true;
		else if (flag === "--help" || flag === "-h") options.help = true;
		else if (flag === "--footage" || flag === "--data" || flag === "--port") {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(flag + " needs a value.");
			if (flag === "--footage") options.footage = value;
			if (flag === "--data") options.data = value;
			if (flag === "--port") {
				const port = Number(value);
				if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
					throw new Error("Port must be an integer from 1 to 65535.");
				}
				options.port = port;
			}
		} else {
			throw new Error("Unknown option. Usage: " + USAGE);
		}
	}
	return options;
}

function quotePath(value: string): string {
	const quote = ['"', "'", "`"].find((candidate) => !value.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(value)));
	if (!quote || /[\r\n\0]/.test(value)) {
		throw new Error("The folder path cannot be represented in .env.local.");
	}
	return quote + value.replaceAll("$", () => "\\$") + quote;
}

export function mergeEnv(source: string, values: FolderValues, approved: FolderKey[] = []): string {
	const found = new Set<string>();
	let result = source.replace(assignment, (line: string, prefix: string, key: FolderKey, _value: string, suffix: string) => {
		found.add(key);
		const value = values[key];
		return value !== undefined && approved.includes(key) ? prefix + quotePath(value) + suffix : line;
	});

	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	for (const { key } of folderSettings) {
		const value = values[key];
		if (value === undefined || found.has(key)) continue;
		if (result && !result.endsWith("\n")) result += newline;
		result += key + "=" + quotePath(value) + newline;
	}
	return result;
}

export async function toolWarnings(
	env: Record<string, string | undefined>,
	probe: (command: string[]) => Promise<boolean>,
): Promise<string[]> {
	const checks = [
		{
			command: [...commandFromSetting(env.BOPENCUT_FFMPEG, "ffmpeg"), "-version"],
			warning: "ffmpeg unavailable. GIF conversion, media sections and frames from links, and audio normalization need it.",
		},
		{
			command: [...commandFromSetting(env.BOPENCUT_YTDLP, "yt-dlp"), "--version"],
			warning: "yt-dlp unavailable. Media sections and frames from links and online music need it.",
		},
	];
	const available = await Promise.all(checks.map(({ command }) => probe(command)));
	return checks.filter((_, index) => !available[index]).map(({ warning }) => warning);
}

function probeTool([command, ...args]: string[], cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, timeout: 3000, windowsHide: true }, (error) => resolve(!error));
	});
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

function runBun(args: string[], cwd: string, env = process.env): Promise<number> {
	const windows = process.platform === "win32";
	const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", detached: !windows });
	const signalGroup = (signal: NodeJS.Signals) => {
		if (!child.pid || windows) return;
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	// On Windows, the foreground processes share the console's Ctrl+C event.
	const interrupt = () => signalGroup("SIGINT");
	const terminate = () => signalGroup("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	return new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
	}).finally(() => {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	});
}

async function setupEnv(file: string, original: string | undefined, options: Options) {
	const source = original ?? "";
	const current = envValues(source);
	const firstSetup = !source.split(/\r?\n/).includes(SETUP_COMMENT);
	const values: FolderValues = {};
	const approved: FolderKey[] = [];
	const terminal = !options.yes && process.stdin.isTTY && process.stdout.isTTY
		? createInterface({ input: process.stdin, output: process.stdout })
		: undefined;

	try {
		for (const { key, option, label } of folderSettings) {
			const configured = Object.hasOwn(current, key);
			if (process.env[key] !== undefined || (configured && options.yes)) continue;
			let value = options[option];
			if (value === undefined && firstSetup && !configured) {
				value = (await terminal?.question(label + " [Enter for default]: "))?.trim();
			}
			if (!value) continue;
			value = path.resolve(value);
			if (process.platform === "win32") value = value.replaceAll("\\", "/");
			if (configured) {
				if (value === current[key]) continue;
				const answer = await terminal?.question("Replace the existing " + key + " setting? [y/N] ");
				if (!/^y(?:es)?$/i.test(answer?.trim() ?? "")) continue;
				approved.push(key);
			}
			values[key] = value;
		}
	} finally {
		terminal?.close();
	}

	// Remember accepted defaults without pinning them to paths in this checkout.
	const markDefaults = firstSetup && folderSettings.some(({ key }) => !Object.hasOwn(current, key));
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const base = markDefaults ? SETUP_COMMENT + newline + source : source;
	const next = mergeEnv(base, values, approved);
	if (next === original) return;

	const temporary = file + "." + randomUUID() + ".tmp";
	try {
		await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
		if (await readOptional(file) !== original || (original !== undefined && (await lstat(file)).isSymbolicLink())) {
			throw new Error(".env.local changed during setup or is a symbolic link. Check the file before retrying.");
		}
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function findNext(web: string, root: string): Promise<string | undefined> {
	// Keep the workspace link in the path so Next resolves its own package imports.
	for (const directory of [web, root]) {
		const file = path.join(directory, "node_modules/next/dist/bin/next");
		if (await Bun.file(file).exists()) return file;
	}
	return undefined;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	if (!process.versions.bun) throw new Error("Install Bun to run bopencut.");
	const web = path.resolve(import.meta.dir, "..");
	const root = path.resolve(web, "../..");
	const file = path.join(web, ".env.local");
	const original = await readOptional(file);
	const env = { ...envValues(original ?? ""), ...process.env };
	for (const warning of await toolWarnings(env, (command) => probeTool(command, web))) {
		console.warn(warning);
	}

	const stamp = path.join(root, "node_modules/.bopencut-install");
	const fingerprint = createHash("sha256").update(await readFile(path.join(root, "bun.lock"))).digest("hex");
	if (!(await findNext(web, root)) || await readOptional(stamp) !== fingerprint) {
		console.log("Installing dependencies...");
		const code = await runBun(["install", "--frozen-lockfile"], root);
		if (code !== 0) {
			process.exitCode = code;
			return;
		}
		await writeFile(stamp, fingerprint);
	}

	if (!(await findNext(web, root))) throw new Error("Next.js could not be found after dependency setup.");
	await setupEnv(file, original, options);
	console.log("Editor: http://127.0.0.1:" + options.port + "/projects");
	console.log('Tell your agent: "Read AGENTS.md, then help me make a video from these sources."');
	process.exitCode = await runBun(
		["--no-env-file", "--bun", "run", "dev", "-H", "127.0.0.1", "-p", String(options.port)],
		web,
		{ ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development" },
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Local startup failed.");
		process.exitCode = 1;
	});
}
