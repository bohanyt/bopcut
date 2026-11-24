import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture } from "@/timeline/__tests__/compound-fixtures";
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

test("preferences are not served, and requests from another origin are refused", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prefs-test-"));
	const endpoint = "http://localhost:3100/api/agent/cli/";
	try {
		await fs.writeFile(path.join(workspace, "PREFERENCES.md"), "Use plain captions.");
		const prefs = await handleCli(new Request(endpoint + "prefs"), "prefs", workspace);
		expect(prefs.status).toBe(404);
		expect(JSON.stringify(await prefs.json())).not.toContain("plain captions");
		const foreign = await handleCli(new Request(endpoint + "status", { headers: { Origin: "http://localhost:4100" } }), "status", workspace);
		expect(foreign.status).toBe(403);
	} finally {
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

test("transcript view reads the saved root and media without a workspace snapshot", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-transcript-view-"));
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	const call = (media?: string) => {
		const params = new URLSearchParams({ projectId: "demo", ...(media && { media }) });
		return handleCli(new Request(`http://localhost:3100/api/agent/cli/transcript-view?${params}`), "transcript-view", workspace);
	};
	try {
		const project = path.join(workspace, "projects", "demo");
		const projectFile = path.join(project, "project.json");
		const metadata = path.join(project, "media", "_metadata");
		await fs.mkdir(metadata, { recursive: true });
		const [root] = fixture();
		root.tracks.main.elements = [];
		root.tracks.overlay = [];
		const { params: _params, ...clip } = audio("voice", 3, 5);
		const metadataHeader = { id: "demo", name: "Saved fixture" };
		const tracks = { ...root.tracks, audio: [{ ...root.tracks.audio[0], elements: [clip] }] };
		const current = { version: CURRENT_PROJECT_VERSION, metadata: metadataHeader,
			scenes: [{ ...root, tracks }], currentSceneId: root.id };
		await fs.writeFile(projectFile, JSON.stringify(current));
		await fs.writeFile(path.join(metadata, "media-voice.json"),
			JSON.stringify({ name: "Recording", duration: 8, words: [{ text: "hello", start: 1, end: 2 }] }));
		await fs.writeFile(path.join(metadata, "other.json"), JSON.stringify({ name: "Recording", duration: 2 }));
		const timeline = await call();
		expect(timeline.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await timeline.text()).toContain("4-5 |1-2 +4 #1 hello");
		const source = await (await call("media-voice")).text();
		expect(source).toContain("1-2 +1 #1 hello");
		expect(source).toContain("Recording [media-voice]");
		expect(await (await call("other")).text()).toContain("[no words stored]");
		expect(await (await call("Recording")).json()).toMatchObject({ error: "More than one media file has this name. Use a media ID: media-voice, other." });
		expect((await call("missing")).status).toBe(400);
		expect(await fs.readdir(workspace)).toEqual(["projects"]);

		const legacy = JSON.stringify({
			...current, version: 22,
			scenes: [{ ...root, tracks: [{ ...root.tracks.main, isMain: true },
				{ ...root.tracks.audio[0], elements: [{ ...clip, startTime: 3, duration: 5, params: {} }] }] }],
		});
		await fs.writeFile(projectFile, legacy);
		expect(await (await call()).text()).toContain("4-5 |1-2 +4 #1 hello");
		expect(await fs.readFile(projectFile, "utf8")).toBe(legacy);

		await fs.writeFile(projectFile, JSON.stringify({ ...current, version: CURRENT_PROJECT_VERSION + 1 }));
		expect(await (await call()).json()).toMatchObject({ error: expect.stringContaining("unsupported version") });
		const invalid = { ...tracks, audio: [{ ...tracks.audio[0], elements: [{ ...clip, duration: null }] }] };
		await fs.writeFile(projectFile, JSON.stringify({ ...current, scenes: [{ ...root, tracks: invalid }] }));
		expect(await (await call()).json()).toMatchObject({ error: expect.stringContaining("invalid clip timing") });
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

test("a chosen project reads its own snapshot even when the last synced snapshot is unreadable", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-own-"));
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	try {
		await fs.mkdir(path.join(workspace, "projects", "demo"), { recursive: true });
		await fs.writeFile(path.join(workspace, "projects", "demo", "project.json"), "{}");
		await fs.mkdir(path.join(workspace, "sync"));
		const snapshot = { projectId: "demo", syncedAt: "own", notes: [] };
		await fs.writeFile(path.join(workspace, "sync", "demo.json"), JSON.stringify(snapshot));
		await fs.writeFile(path.join(workspace, "project.json"), "{ not json");
		const result = await handleCli(new Request("http://127.0.0.1:3100/api/agent/cli/status?projectId=demo"), "status", workspace);
		expect(await result.json()).toEqual({ projectId: "demo", snapshot });
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
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

test("a half-written project snapshot falls back to the last synced snapshot of the same project", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-half-"));
	const data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	const call = (query = "") => handleCli(new Request(`http://127.0.0.1:3100/api/agent/cli/status${query}`), "status", workspace);
	try {
		await fs.mkdir(path.join(workspace, "projects", "demo"), { recursive: true });
		await fs.writeFile(path.join(workspace, "projects", "demo", "project.json"), "{}");
		await fs.mkdir(path.join(workspace, "sync"));
		await fs.writeFile(path.join(workspace, "sync", "demo.json"), "{ not json");
		const snapshot = { projectId: "demo", syncedAt: "last", notes: [] };
		await fs.writeFile(path.join(workspace, "project.json"), JSON.stringify(snapshot));
		expect(await (await call("?projectId=demo")).json()).toEqual({ projectId: "demo", snapshot });
		expect(await (await call()).json()).toEqual({ projectId: "demo", snapshot });
		const notes = await handleCli(new Request("http://127.0.0.1:3100/api/agent/cli/notes?projectId=demo"), "notes", workspace);
		expect(await notes.json()).toEqual({ projectId: "demo", notes: [], syncedAt: "last" });
		await fs.writeFile(path.join(workspace, "project.json"), "{ not json");
		for (const command of ["status", "notes"]) {
			const plain = await handleCli(new Request(`http://127.0.0.1:3100/api/agent/cli/${command}`), command, workspace);
			expect(plain.status).toBe(404);
			expect((await plain.json()).error).toContain("Open a project in the editor");
		}
	} finally {
		if (data === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = data;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});
