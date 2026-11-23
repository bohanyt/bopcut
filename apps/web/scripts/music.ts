// Music without the editor: search the music folders and online, and save a song (sound only) under
// AGENT_FILES_ROOT so it can be used as a draft or bundle asset `path`.
//
//   bun apps/web/scripts/music.ts search <query> [--source library|online] [--limit N]
//   bun apps/web/scripts/music.ts find <query> [--source library|online]      (search + get the best match)
//   bun apps/web/scripts/music.ts get <library|online> <ref or song link>
//
// Prints JSON. Settings come from the environment or apps/web/.env.local (AGENT_FILES_ROOT,
// BOPENCUT_MUSIC_DIRS, BOPENCUT_MUSIC_LOUDNESS, BOPENCUT_MUSIC_MAX_SECONDS, BOPENCUT_YTDLP, ...; see AGENT.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handleMusic } from "../src/sounds/music-server";

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
	console.error("usage: music.ts search <query> [--source library|online] [--limit N]");
	console.error("       music.ts find <query> [--source library|online]");
	console.error("       music.ts get <library|online> <ref or song link>");
	process.exit(2);
}

loadEnvLocal(path.join(webDir, ".env.local"));
const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
const filesRoot = path.resolve(process.env.AGENT_FILES_ROOT ?? workspace);

const [kind, ...rest] = process.argv.slice(2);
let body: Record<string, unknown>;
if (kind === "get") {
	const [source, ref] = rest;
	if (!source || !ref) usage("get needs <source> <ref>");
	body = { kind, source, ref };
} else if (kind === "search" || kind === "find") {
	const words: string[] = [];
	const sources: string[] = [];
	let limit: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--source") sources.push(rest[++i] ?? usage("--source needs a value"));
		else if (rest[i] === "--limit") limit = Number(rest[++i]);
		else if (rest[i].startsWith("--")) usage(`unknown option: ${rest[i]}`);
		else words.push(rest[i]);
	}
	if (!words.length) usage("missing <query>");
	body = { kind, query: words.join(" "), ...(sources.length ? { sources } : {}), ...(limit ? { limit } : {}) };
} else usage();

const result = await handleMusic(body, { filesRoot });
console.log(JSON.stringify(result.body, null, 1));
process.exit(result.status === 200 ? 0 : 1);
