import { expect, test } from "bun:test";
import { parseArgs } from "./agent";

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
