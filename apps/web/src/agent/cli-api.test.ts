import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCli } from "./cli-api";

test("the local CLI reads the last project and filters selection without writing", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-test-"));
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	const call = (command: string, query = "") =>
		handleCli(new Request(`http://127.0.0.1:3100/api/agent/cli/${command}${query}`), command, workspace);
	try {
		const projectDir = path.join(workspace, "projects", "demo");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(path.join(projectDir, "project.json"), "{}");
		const snapshot = { projectId: "demo", ready: true, syncedAt: "test", notes: [{ id: "one", text: "Check the cut" }] };
		await fs.writeFile(path.join(workspace, "project.json"), JSON.stringify(snapshot));
		await fs.writeFile(path.join(workspace, "selection.json"), JSON.stringify({ projectId: "demo", playhead: 3 }));
		const before = await fs.readdir(workspace);
		expect(await (await call("status")).json()).toEqual({ projectId: "demo", snapshot });
		expect(await (await call("notes")).json()).toEqual({ projectId: "demo", notes: snapshot.notes, syncedAt: "test" });
		expect(await (await call("selection")).json()).toEqual({ selection: { projectId: "demo", playhead: 3 } });
		expect(await (await call("selection", "?projectId=other")).json()).toEqual({ selection: null });
		expect(await fs.readdir(workspace)).toEqual(before);
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

test("preferences mark missing files and reject requests from another origin", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prefs-test-"));
	const prefs = process.env.AGENT_PREFS;
	process.env.AGENT_PREFS = path.join(workspace, "general");
	const endpoint = "http://localhost:3100/api/agent/cli/prefs";
	try {
		await fs.writeFile(path.join(workspace, "PREFERENCES.md"), "Use plain captions.");
		const result = await handleCli(new Request(endpoint), "prefs", workspace);
		expect(await result.json()).toEqual({
			general: { missing: true, content: null },
			workspace: { missing: false, content: "Use plain captions." },
		});
		const foreign = await handleCli(new Request(endpoint, { headers: { Origin: "http://localhost:4100" } }), "prefs", workspace);
		expect(foreign.status).toBe(403);
	} finally {
		if (prefs === undefined) delete process.env.AGENT_PREFS;
		else process.env.AGENT_PREFS = prefs;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

test("a chosen project falls back to the last snapshot when it is that project's", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-pick-"));
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	const call = (command: string, id: string) =>
		handleCli(new Request(`http://127.0.0.1:3100/api/agent/cli/${command}?projectId=${id}`), command, workspace);
	try {
		for (const id of ["demo", "other"]) {
			await fs.mkdir(path.join(workspace, "projects", id), { recursive: true });
			await fs.writeFile(path.join(workspace, "projects", id, "project.json"), "{}");
		}
		const snapshot = { projectId: "demo", syncedAt: "test", notes: [{ id: "one", text: "Tighten the start" }] };
		await fs.writeFile(path.join(workspace, "project.json"), JSON.stringify(snapshot));
		expect(await (await call("status", "demo")).json()).toEqual({ projectId: "demo", snapshot });
		expect(await (await call("notes", "demo")).json()).toEqual({ projectId: "demo", notes: snapshot.notes, syncedAt: "test" });
		expect(await (await call("status", "other")).json()).toEqual({ projectId: "other", snapshot: null });
		expect(await (await call("notes", "other")).json()).toEqual({ projectId: "other", notes: [], syncedAt: null });
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

test("reads refuse links that lead out of the workspace", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-link-"));
	const workspace = path.join(root, "workspace");
	const outside = path.join(root, "outside");
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	try {
		await fs.mkdir(path.join(workspace, "projects", "demo"), { recursive: true });
		await fs.writeFile(path.join(workspace, "projects", "demo", "project.json"), "{}");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "demo.json"), JSON.stringify({ projectId: "demo", notes: [{ id: "secret" }] }));
		await fs.symlink(outside, path.join(workspace, "sync"), "junction");
		const result = await handleCli(new Request("http://127.0.0.1:3100/api/agent/cli/notes?projectId=demo"), "notes", workspace);
		expect(result.status).toBe(500);
		expect(JSON.stringify(await result.json())).not.toContain("secret");
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
		await fs.rm(root, { recursive: true, force: true });
	}
});
