// Ducking keyframes without the editor: find where the voices speak and print volume keyframes that
// lower the music there. Put them on the music element (draft/bundle `keyframes`); each stays editable.
//
//   bun apps/web/scripts/duck.ts --music-duration 30 [--music-start 0] [--base -6] [--amount -12]
//        [--attack 0.15] [--release 0.5] [--threshold -40]
//        --voice <path>[@start[+trimStart]][:duration] [--voice ...]
//
// <path> is relative to AGENT_FILES_ROOT. `start` is the voice element's timeline start (default 0),
// `trimStart` where it starts in its file (default 0) and `duration` its length (default: music duration).
// Prints JSON {segments, keyframes}. Settings come from the environment or apps/web/.env.local.
import { loadEnvLocal } from "./local-env";
import path from "node:path";
import { handleDuck } from "../src/sounds/duck-server";

const webDir = path.resolve(import.meta.dir, "..");

function usage(message?: string): never {
	if (message) console.error(message);
	console.error("usage: duck.ts --music-duration S [--music-start S] [--base dB] [--amount dB] [--attack S] [--release S] [--threshold dB] --voice <path>[@start[+trimStart]][:duration] ...");
	process.exit(2);
}

loadEnvLocal(path.join(webDir, ".env.local"));
const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
const filesRoot = path.resolve(process.env.AGENT_FILES_ROOT ?? workspace);

const args = process.argv.slice(2);
const num = (flag: string): number | undefined => {
	const i = args.indexOf(flag);
	if (i < 0) return undefined;
	const n = Number(args[i + 1]);
	if (!Number.isFinite(n)) usage(`${flag} needs a number`);
	return n;
};
const musicDuration = num("--music-duration") ?? usage("--music-duration is required");
const voices: { path: string; start: number; trimStart?: number; duration: number }[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] !== "--voice") continue;
	const spec = args[i + 1] ?? usage("--voice needs a value");
	const m = /^(.+?)(?:@(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?)?(?::(\d+(?:\.\d+)?))?$/.exec(spec);
	if (!m) usage(`bad --voice: ${spec}`);
	voices.push({ path: m[1], start: Number(m[2] ?? 0), ...(m[3] ? { trimStart: Number(m[3]) } : {}), duration: Number(m[4] ?? musicDuration) });
}
if (!voices.length) usage("at least one --voice is required");

const body = {
	music: { duration: musicDuration, start: num("--music-start"), baseDb: num("--base") },
	voices,
	amountDb: num("--amount"),
	attack: num("--attack"),
	release: num("--release"),
	thresholdDb: num("--threshold"),
};
const result = await handleDuck(JSON.parse(JSON.stringify(body)), { filesRoot });
console.log(JSON.stringify(result.body, null, 1));
process.exit(result.status === 200 ? 0 : 1);
