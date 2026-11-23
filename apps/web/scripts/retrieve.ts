// Fetch a section (or one frame) of an online video into AGENT_FILES_ROOT/retrieved/, without the editor.
//
//   bun apps/web/scripts/retrieve.ts section <url> [--start T] (--end T | --duration T) [--height N] [--audio-only]
//   bun apps/web/scripts/retrieve.ts frame <url> [--at T] [--width N]
//
// T is seconds, 1:02:03 or 1h2m3s; --start/--at default to the link's own t=. Prints the result as JSON:
// use its `path` as a draft or bundle asset path. Settings come from the environment or apps/web/.env.local
// (AGENT_FILES_ROOT, AGENT_WORKSPACE, BOPENCUT_YTDLP, BOPENCUT_FFMPEG, ...; see AGENT.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handleRetrieve } from "../src/retrieval/server";

const webDir = path.resolve(import.meta.dir, "..");

function loadEnvLocal(file: string) {
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trim().startsWith("#")) continue;
		const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
		if (process.env[m[1]] === undefined) process.env[m[1]] = value;
	}
}

function usage(message?: string): never {
	if (message) console.error(message);
	console.error("usage: retrieve.ts section <url> [--start T] (--end T | --duration T) [--height N] [--audio-only]");
	console.error("       retrieve.ts frame <url> [--at T] [--width N]");
	process.exit(2);
}

loadEnvLocal(path.join(webDir, ".env.local"));
const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
const filesRoot = path.resolve(process.env.AGENT_FILES_ROOT ?? workspace);

const [kind, url, ...rest] = process.argv.slice(2);
if (kind !== "section" && kind !== "frame") usage();
if (!url) usage("missing <url>");

const options: Record<string, string | boolean> = {};
for (let i = 0; i < rest.length; i++) {
	const flag = rest[i];
	if (!flag.startsWith("--")) usage(`unexpected argument: ${flag}`);
	const name = flag.slice(2);
	if (name === "audio-only") options.audioOnly = true;
	else if (["start", "end", "duration", "height", "at", "width"].includes(name)) {
		const value = rest[++i];
		if (value === undefined) usage(`${flag} needs a value`);
		options[name] = value;
	} else usage(`unknown option: ${flag}`);
}

const body =
	kind === "section"
		? { kind, url, start: options.start, end: options.end, duration: options.duration, height: options.height, audioOnly: options.audioOnly }
		: { kind, url, time: options.at, width: options.width };
const result = await handleRetrieve(body, { filesRoot });
console.log(JSON.stringify(result.body, null, 1));
process.exit(result.status === 200 ? 0 : 1);
