// Sound effects without the editor: search the library folders and myinstants.com, and save a sound
// under AGENT_FILES_ROOT so it can be used as a draft or bundle asset `path`.
//
//   bun apps/web/scripts/sfx.ts search <query> [--source library|myinstants] [--limit N]
//   bun apps/web/scripts/sfx.ts find <query> [--source library|myinstants]      (search + get the best match)
//   bun apps/web/scripts/sfx.ts get <library|myinstants> <ref> [--name TITLE]
//
// Prints JSON. Settings come from the environment or apps/web/.env.local (AGENT_FILES_ROOT,
// BOPENCUT_SFX_DIRS, BOPENCUT_SFX_NORMALIZE, BOPENCUT_FFMPEG; see AGENT.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { retrievalOptions, runRetrievalCli } from "./retrieval-cli";
import { handleSfx } from "../src/sounds/sfx-server";

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
	console.error("usage: sfx.ts search <query> [--source library|myinstants] [--limit N]");
	console.error("       sfx.ts find <query> [--source library|myinstants]");
	console.error("       sfx.ts get <library|myinstants> <ref>");
	process.exit(2);
}

loadEnvLocal(path.join(webDir, ".env.local"));
const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
const filesRoot = path.resolve(process.env.AGENT_FILES_ROOT ?? workspace);

const { args, timeout } = retrievalOptions(process.argv.slice(2), usage);
const [kind, ...rest] = args;
let body: Record<string, unknown>;
if (kind === "get") {
	const [source, ref, ...more] = rest;
	if (!source || !ref) usage("get needs <source> <ref>");
	const nameAt = more.indexOf("--name");
	body = { kind, source, ref, ...(nameAt >= 0 && more[nameAt + 1] ? { name: more[nameAt + 1] } : {}) };
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

await runRetrievalCli(timeout, (signal) => handleSfx(body, { filesRoot, signal }));
