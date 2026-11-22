import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, parseEnvFile, readPreferences } from "./agent";

test("the read-only commands share project and timeout options", () => {
	for (const command of ["status", "selection", "notes", "prefs"] as const) {
		expect(parseArgs([command, "--project-id", "project", "--timeout", "12", "--url", "http://localhost:3100"]))
			.toEqual({ command, projectId: "project", timeoutMs: 12000, origin: "http://localhost:3100" });
	}
});

test("the CLI rejects deferred commands, unexpected options, and remote addresses", () => {
	expect(() => parseArgs(["draft"])).toThrow("status|selection|notes|prefs");
	expect(() => parseArgs(["notes", "--fps", "30"])).toThrow("Unknown option");
	expect(() => parseArgs(["status", "--timeout", "0"])).toThrow("timeout");
	expect(() => parseArgs(["status", "--url", "https://example.com"])).toThrow("local editor origin");
});

test("env files are read like the editor server reads them", () => {
	expect(parseEnvFile([
		"# a comment",
		"AGENT_PREFS=/prefs/general      # General rules",
		"export AGENT_WORKSPACE=\"../work space\"",
		"EMPTY=",
		"QUOTED='a # not a comment'",
	].join("\r\n"))).toEqual({ AGENT_PREFS: "/prefs/general", AGENT_WORKSPACE: "../work space", EMPTY: "", QUOTED: "a # not a comment" });
});

test("preferences are read locally from the environment, then the editor's env file", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prefs-local-"));
	const web = path.join(root, "web");
	try {
		await fs.mkdir(path.join(root, "general"), { recursive: true });
		await fs.mkdir(path.join(root, "work"), { recursive: true });
		await fs.mkdir(web);
		await fs.writeFile(path.join(root, "general", "PREFERENCES.md"), "Cut tight.");
		await fs.writeFile(path.join(web, ".env.local"), "AGENT_PREFS=../general  # rules\nAGENT_WORKSPACE=../missing\n");
		expect(await readPreferences({}, web)).toEqual({
			general: { missing: false, content: "Cut tight." },
			workspace: { missing: true, content: null },
		});
		await fs.writeFile(path.join(root, "work", "PREFERENCES.md"), "Raise captions.");
		expect(await readPreferences({ AGENT_WORKSPACE: path.join(root, "work") }, web)).toEqual({
			general: { missing: false, content: "Cut tight." },
			workspace: { missing: false, content: "Raise captions." },
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a preference file that links out of its folder is refused", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prefs-link-"));
	try {
		await fs.mkdir(path.join(root, "general"));
		await fs.writeFile(path.join(root, "secret.md"), "outside");
		try { await fs.symlink(path.join(root, "secret.md"), path.join(root, "general", "PREFERENCES.md"), "file"); }
		catch (error) {
			// File links need extra rights on some Windows setups; the containment check is the same for folders.
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		await expect(readPreferences({ AGENT_PREFS: path.join(root, "general"), AGENT_WORKSPACE: root }, root)).rejects.toThrow("not a file inside its folder");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
