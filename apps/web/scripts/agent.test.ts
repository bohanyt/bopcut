import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "./agent";

test("transcript CLI parses its source, language, range, timeout and project", () => {
	expect(parseArgs(["transcript", "https://example.com/video", "--lang", "es", "--range", "1:02-1:03.5",
		"--timeout", "12", "--project-id", "demo"])).toMatchObject({
		command: "transcript", projectId: "demo", timeoutMs: 12000,
		request: { url: "https://example.com/video", language: "es", range: { start: 62, end: 63.5 } },
	});
	expect(() => parseArgs(["transcript"])).toThrow("transcript <url>");
	expect(() => parseArgs(["transcript", "file:///example"])).toThrow("http(s)");
	expect(() => parseArgs(["transcript", "https://example.com/video", "--range", "3-2"])).toThrow("--range");
	expect(() => parseArgs(["transcript", "https://example.com/video", "--lang", ".*"])).toThrow("--lang");
});

test("transcript CLI leaves its workspace and tool scratch empty", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "transcript-cli-"));
	const workspace = path.join(root, "workspace");
	const fixture = path.join(root, "fake-captions.js");
	await mkdir(workspace);
	await writeFile(fixture, `
		const { writeFileSync, readFileSync } = require("node:fs");
		const path = require("node:path");
		const args = process.argv.slice(2);
		const info = args.indexOf("--load-info-json");
		if (info < 0) console.log(JSON.stringify({
			id: "demo", extractor_key: "Example", subtitles: { en: [{ ext: "vtt", data: "fixture" }] },
		}));
		else {
			const file = args[info + 1];
			JSON.parse(readFileSync(file, "utf8"));
			writeFileSync(path.join(path.dirname(file), "captions.en.vtt"),
				"WEBVTT\\n\\n00:01.000 --> 00:02.000\\nExample caption\\n");
		}
	`);
	const jobs = path.join(root, ".bopencut-tool-jobs" + (process.getuid ? "-" + process.getuid() : ""), ".retrieval-jobs");
	try {
		const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "agent.ts"), "transcript",
			"https://example.com/video", "--timeout", "8"], { timeout: 10_000, env: { ...process.env,
			AGENT_WORKSPACE: workspace, AGENT_FILES_ROOT: workspace, BOPENCUT_ALLOW_PRIVATE_URLS: "1",
			BOPENCUT_YTDLP: '"' + process.execPath + '" "' + fixture + '"', TMPDIR: root, TMP: root, TEMP: root,
		} });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString()).cues).toEqual([{ start: 1, end: 2, text: "Example caption" }]);
		expect(await readdir(workspace)).toEqual([]);
		expect(await readdir(jobs)).toEqual([]);
	} finally {
		await unlink(fixture);
		await rmdir(workspace);
		await rmdir(jobs);
		await rmdir(path.dirname(jobs));
		await rmdir(root);
	}
}, 12_000);

test("the read-only commands share project and timeout options", () => {
	for (const command of ["status", "selection", "notes"] as const) {
		expect(parseArgs([command, "--project-id", "project", "--timeout", "12", "--url", "http://localhost:3100"]))
			.toEqual({ command, projectId: "project", timeoutMs: 12000, origin: "http://localhost:3100" });
	}
});

test("silence-plan needs a project and passes its options to the server", () => {
	expect(parseArgs(["silence-plan", "--project-id", "p", "--min-gap", "0.3", "--pad", "0.05", "--keep-fillers", "--tail",
		"--ignore-media", "Music,SFX"])).toMatchObject({
		command: "silence-plan", projectId: "p", silence: { minGap: "0.3", pad: "0.05", fillers: "0", tail: "1", ignore: "Music,SFX" },
	});
	expect(parseArgs(["silence-plan", "--project-id", "p", "--json"])).toMatchObject({ silence: {} });
	expect(() => parseArgs(["silence-plan"])).toThrow("Use silence-plan --project-id ID");
});

test("the CLI rejects deferred commands, unexpected options, and remote addresses", () => {
	expect(() => parseArgs(["draft"])).toThrow("status|selection|notes");
	expect(() => parseArgs(["prefs"])).toThrow("status|selection|notes");
	expect(() => parseArgs(["notes", "--fps", "30"])).toThrow("Unknown option");
	expect(() => parseArgs(["status", "--timeout", "0"])).toThrow("timeout");
	expect(() => parseArgs(["status", "--url", "https://example.com"])).toThrow("local editor origin");
});

test("range view validates limits and requires exactly one source", () => {
	expect(parseArgs(["view", "--project-id", "demo", "--from", "10", "--to", "25"])).toMatchObject({
		command: "view", request: { from: 10, to: 25, rows: 8 },
	});
	expect(parseArgs(["view", "--file", "demo.mp4", "--from", "0", "--to", "2", "--rows", "2"])).toMatchObject({
		command: "file-view", file: "demo.mp4", rangeView: { from: 0, to: 2, rows: 2 },
	});
	expect(() => parseArgs(["view", "--from", "0", "--to", "1"])).toThrow("either --project-id");
	expect(() => parseArgs(["view", "--project-id", "demo", "--from", "0", "--to", "121"])).toThrow("120 seconds");
	expect(() => parseArgs(["transcript-view", "--project-id", "demo", "--media", "name", "--timeline"])).toThrow("transcript-view");
});

test("finished review requires a project and file and permits opting out of pictures", () => {
	expect(parseArgs(["review", "--project-id", "demo", "--file", "out.mp4", "--pictures", "none"]))
		.toMatchObject({ command: "review", projectId: "demo", file: "out.mp4", pictures: false, timeoutMs: undefined });
	expect(parseArgs(["review", "--project-id", "demo", "--file", "out.mp4", "--timeout", "300"])).toMatchObject({ timeoutMs: 300000 });
	expect(() => parseArgs(["review", "--file", "out.mp4"])).toThrow("--project-id");
	expect(() => parseArgs(["review", "--project-id", "demo", "--file", "out.mp4", "--pictures", "all"])).toThrow("--pictures none");
});
