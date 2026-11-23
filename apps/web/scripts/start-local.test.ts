import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { directEnvValues, envValues } from "./local-env";
import { mergeEnv, parseArgs, readDevelopmentSettings, setupEnv, toolWarnings } from "./start-local";

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
			.toBe(original + '\r\nBOPENCUT_DATA="/my data" # bopencut local path\r\n');
	});

	test("updates approved duplicates without stripping comments or multiline values", () => {
		const original = 'SECRET="first\nAGENT_FILES_ROOT=inside secret\nlast"\n'
			+ 'export AGENT_FILES_ROOT = "/old" # used for footage\nAGENT_FILES_ROOT=/duplicate\n';
		expect(mergeEnv(original, { AGENT_FILES_ROOT: "/new # footage" }, ["AGENT_FILES_ROOT"]))
			.toBe('SECRET="first\nAGENT_FILES_ROOT=inside secret\nlast"\n'
				+ 'export AGENT_FILES_ROOT = "/new # footage" # used for footage # bopencut local path\nAGENT_FILES_ROOT="/new # footage" # bopencut local path\n');
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

test("leaves an escaped backtick and nested assignment inside a multiline value intact", () => {
	const original = "SECRET=\x60before \\\x60 escaped\nAGENT_FILES_ROOT=/within-secret\nafter\x60\nAGENT_FILES_ROOT=/real\n";
	const merged = mergeEnv(original, { AGENT_FILES_ROOT: "/approved" }, ["AGENT_FILES_ROOT"]);
	expect(merged.slice(0, original.indexOf("/real"))).toBe(original.slice(0, original.indexOf("/real")));
	expect(envValues(merged).SECRET).toBe(envValues(original).SECRET);
	expect(envValues(merged).AGENT_FILES_ROOT).toBe("/approved");
});

test("development settings retain precedence across all Next env files and the process env", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "bopencut-precedence-"));
	try {
		await writeFile(path.join(directory, ".env"), "BOPENCUT_DATA=/existing\n");
		await writeFile(path.join(directory, ".env.development"), "AGENT_FILES_ROOT=/development\n");
		await writeFile(path.join(directory, ".env.development.local"), "AGENT_FILES_ROOT=/developer\n");
		const settings = await readDevelopmentSettings(directory, undefined, {});
		expect(settings.effective).toEqual({ BOPENCUT_DATA: "/existing", AGENT_FILES_ROOT: "/developer" });
		expect(settings.overrides).toEqual({ AGENT_FILES_ROOT: "/developer" });
		const file = path.join(directory, ".env.local");
		await setupEnv(file, undefined, parseArgs(["--data", "/other", "--footage", "/other", "--yes"]), settings);
		expect(envValues(await readFile(file, "utf8"))).toEqual({});
		const local = await readDevelopmentSettings(directory, "BOPENCUT_DATA=/local\n", { AGENT_FILES_ROOT: "/process" });
		expect(local.effective).toEqual({ BOPENCUT_DATA: "/local", AGENT_FILES_ROOT: "/process" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("direct-file commands retain legacy literal settings and decode launcher paths", () => {
	const original = 'BOPENCUT_SFX_DIRS=C:/SFX # backups\nAGENT_WORKSPACE="C:\\new\\raw"\n';
	const merged = mergeEnv(original, { AGENT_FILES_ROOT: "/footage #1 $clip" });
	expect(directEnvValues(merged)).toEqual({
		BOPENCUT_SFX_DIRS: "C:/SFX # backups",
		AGENT_WORKSPACE: "C:\\new\\raw",
		AGENT_FILES_ROOT: "/footage #1 $clip",
	});
});

test("the playbook targets the chosen project for frames and export", async () => {
	const playbook = await readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8");
	expect(playbook).toContain("bun run agent frames --project-id PROJECT_ID");
	expect(playbook).toContain("bun run agent export --project-id PROJECT_ID");
});