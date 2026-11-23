import { expect, test } from "bun:test";
import { parseArgs } from "./agent";

test("transcript CLI parses its source, language, range, refresh, timeout and project", () => {
	expect(parseArgs(["transcript", "https://example.com/video", "--lang", "es", "--range", "1:02-1:03.5",
		"--refresh", "--timeout", "12", "--project-id", "demo"])).toMatchObject({
		command: "transcript", projectId: "demo", timeoutMs: 12000,
		request: { url: "https://example.com/video", language: "es", range: { start: 62, end: 63.5 }, refresh: true },
	});
	expect(() => parseArgs(["transcript"])).toThrow("transcript <url>");
	expect(() => parseArgs(["transcript", "file:///example"])).toThrow("http(s)");
	expect(() => parseArgs(["transcript", "https://example.com/video", "--range", "3-2"])).toThrow("--range");
	expect(() => parseArgs(["transcript", "https://example.com/video", "--lang", ".*"])).toThrow("--lang");
});

test("the read-only commands share project and timeout options", () => {
	for (const command of ["status", "selection", "notes"] as const) {
		expect(parseArgs([command, "--project-id", "project", "--timeout", "12", "--url", "http://localhost:3100"]))
			.toEqual({ command, projectId: "project", timeoutMs: 12000, origin: "http://localhost:3100" });
	}
});

test("the CLI rejects deferred commands, unexpected options, and remote addresses", () => {
	expect(() => parseArgs(["draft"])).toThrow("status|selection|notes");
	expect(() => parseArgs(["prefs"])).toThrow("status|selection|notes");
	expect(() => parseArgs(["notes", "--fps", "30"])).toThrow("Unknown option");
	expect(() => parseArgs(["status", "--timeout", "0"])).toThrow("timeout");
	expect(() => parseArgs(["status", "--url", "https://example.com"])).toThrow("local editor origin");
});
