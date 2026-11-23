import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { envValues } from "./local-env";
import { mergeEnv, parseArgs, toolWarnings } from "./start-local";

describe("start:local arguments", () => {
	test("uses port 3000 and prompts by default", () => {
		expect(parseArgs([])).toEqual({ port: 3000, yes: false, help: false });
	});

	test("accepts non-interactive setup and a different port", () => {
		expect(parseArgs(["--footage", "my footage", "--data", "data", "--yes", "--port", "3100"]))
			.toEqual({ footage: "my footage", data: "data", yes: true, port: 3100, help: false });
	});

	test("rejects missing values, malformed ports and hostname overrides", () => {
		expect(() => parseArgs(["--footage", "--yes"])).toThrow("--footage needs a value");
		expect(() => parseArgs(["--port", "3100x"])).toThrow("Port");
		expect(() => parseArgs(["--port", "65536"])).toThrow("Port");
		expect(() => parseArgs(["--hostname", "0.0.0.0"])).toThrow("Unknown option");
	});
});

describe("local env merge", () => {
	test("preserves configured values, including an empty one, by default", () => {
		const original = '# Keep this\r\nAGENT_FILES_ROOT="old # footage"\r\nBOPENCUT_DATA=\r\nSECRET=private\r\n';
		expect(mergeEnv(original, { AGENT_FILES_ROOT: "/new", BOPENCUT_DATA: "/data" })).toBe(original);
	});

	test("appends a missing setting without changing comments or line endings", () => {
		const original = "# BOPENCUT_DATA=/example\r\nSECRET=private";
		expect(mergeEnv(original, { BOPENCUT_DATA: "/my data" }))
			.toBe(original + '\r\nBOPENCUT_DATA="/my data"\r\n');
	});

	test("updates approved duplicates without stripping comments or multiline values", () => {
		const original = 'SECRET="first\nAGENT_FILES_ROOT=inside secret\nlast"\n'
			+ 'export AGENT_FILES_ROOT = "/old" # used for footage\nAGENT_FILES_ROOT=/duplicate\n';
		expect(mergeEnv(original, { AGENT_FILES_ROOT: "/new # footage" }, ["AGENT_FILES_ROOT"]))
			.toBe('SECRET="first\nAGENT_FILES_ROOT=inside secret\nlast"\n'
				+ 'export AGENT_FILES_ROOT = "/new # footage" # used for footage\nAGENT_FILES_ROOT="/new # footage"\n');
	});
});

test("folder paths round-trip from a temp env file with spaces, hashes and dollar signs", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "bopencut-env-"));
	try {
		const file = path.join(directory, ".env.local");
		const footage = path.join(directory, "footage #1 $clip").split(path.sep).join("/");
		const original = "# Keep this line\nBOPENCUT_DATA: /existing/data\n";
		await writeFile(file, mergeEnv(original, { AGENT_FILES_ROOT: footage, BOPENCUT_DATA: "/new" }));
		const merged = await readFile(file, "utf8");
		expect(merged.startsWith(original)).toBe(true);
		expect(envValues(merged)).toEqual({ AGENT_FILES_ROOT: footage, BOPENCUT_DATA: "/existing/data" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("startup tool checks", () => {
	test("reports each missing optional tool with its features", async () => {
		const warnings = await toolWarnings({}, async () => false);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("GIF");
		expect(warnings[1]).toContain("online music");
	});

	test("probes configured commands with their arguments and stays quiet when present", async () => {
		const checked: string[][] = [];
		const warnings = await toolWarnings({
			BOPENCUT_FFMPEG: '"/opt/media tools/ffmpeg"',
			BOPENCUT_YTDLP: "python -m yt_dlp",
		}, async (command) => {
			checked.push(command);
			return true;
		});
		expect(checked).toEqual([["/opt/media tools/ffmpeg", "-version"], ["python", "-m", "yt_dlp", "--version"]]);
		expect(warnings).toEqual([]);
	});
});
