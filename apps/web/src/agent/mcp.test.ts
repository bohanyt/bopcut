import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture } from "@/timeline/__tests__/compound-fixtures";
import { handleCli } from "./cli-api";
import { consumeAppliedDraft } from "./draft-store";
import { handleMcp, MCP_TOOLS, type McpOptions } from "./mcp";
import { renderPresence } from "./render-server";

let workspace: string;
let data: string | undefined;
beforeAll(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-"));
	data = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = workspace;
	const project = path.join(workspace, "projects", "demo");
	const metadata = path.join(project, "media", "_metadata");
	await fs.mkdir(metadata, { recursive: true });
	const [root] = fixture();
	root.tracks.main.elements = [];
	root.tracks.overlay = [];
	const { params: _params, ...clip } = audio("voice", 0, 8);
	const tracks = { ...root.tracks, audio: [{ ...root.tracks.audio[0], elements: [clip] }] };
	await fs.writeFile(path.join(project, "project.json"), JSON.stringify({ version: CURRENT_PROJECT_VERSION,
		metadata: { id: "demo", name: "Saved fixture", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" },
		scenes: [{ ...root, tracks }], currentSceneId: root.id }));
	await fs.writeFile(path.join(metadata, "media-voice.json"), JSON.stringify({ name: "Recording", duration: 8,
		words: [{ text: "hello", start: 1, end: 2 }, { text: "world", start: 3, end: 4 }] }));
});
afterAll(async () => {
	if (data === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = data;
	await fs.rm(workspace, { recursive: true, force: true });
});

const closedEditor: McpOptions = { editorOpen: async () => false, waitMs: 0 };
let options = closedEditor;
afterEach(async () => {
	options = closedEditor;
	for (const name of ["draft.json", "draft-result.json", "drafts-applied"]) await fs.rm(path.join(workspace, name), { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}, url = "http://127.0.0.1:3000/api/mcp") =>
	handleMcp(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body) }), workspace, options);
const rpc = async (method: string, params?: unknown, url?: string) => (await post({ jsonrpc: "2.0", id: 1, method, params }, {}, url)).json();
const call = async (name: string, args: Record<string, unknown> = {}, url?: string) => (await rpc("tools/call", { name, arguments: args }, url)).result;
const readWorkspace = async (name: string) => JSON.parse(await fs.readFile(path.join(workspace, name), "utf8"));
/** What the open editor does with a draft: move it to drafts-applied/, then write its result. */
async function editorAnswers(result: Record<string, unknown>) {
	const draft = await readWorkspace("draft.json");
	await consumeAppliedDraft(workspace, draft.rev);
	await fs.writeFile(path.join(workspace, "draft-result.json"), JSON.stringify({
		rev: draft.rev, projectId: draft.projectId, appliedAt: new Date().toISOString(), ...result }));
	return draft;
}

test("initialize negotiates the protocol version and lists the tools, marking those that change a project", async () => {
	const known = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	expect(known.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bopcut" } });
	expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
	expect((await rpc("ping")).result).toEqual({});
	const { tools } = (await rpc("tools/list")).result;
	expect(tools.map(({ name }: { name: string }) => name)).toEqual(MCP_TOOLS.map(({ name }) => name));
	for (const tool of tools) {
		expect(tool).toMatchObject({ inputSchema: { type: "object" }, annotations: { readOnlyHint: tool.name !== "submit_draft" } });
	}
	expect(tools.find(({ name }: { name: string }) => name === "submit_draft").annotations.destructiveHint).toBe(true);
	const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
	expect(notified.status).toBe(202);
	const batch = await (await post([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).json();
	expect(batch).toEqual([{ jsonrpc: "2.0", id: "a", result: {} }]);
});

test("tools read projects, transcripts and silence plans of the saved timeline", async () => {
	const listed = await call("list_projects");
	expect(listed.structuredContent).toEqual({ projects: [{ id: "demo", name: "Saved fixture",
		updatedAt: "2026-11-02T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" }] });
	const transcript = await call("read_transcript", { projectId: "demo" });
	expect(transcript.isError).toBeUndefined();
	expect(transcript.content[0].text).toContain("hello");
	const plan = await call("plan_silence_cuts", { projectId: "demo", ignoreMedia: ["Music"] });
	expect(plan.structuredContent.ops).toEqual([{ op: "cut", start: 63 / 30, end: 87 / 30 }, { op: "cut", start: 0, end: 27 / 30 }]);
	expect((await call("plan_silence_cuts", { projectId: "demo", keepLead: true, minGap: 1.5 })).structuredContent.ops).toEqual([]);
});

test("tool problems come back as tool errors with the CLI's messages", async () => {
	expect(await call("get_status", { projectId: "../demo" })).toMatchObject({ isError: true, content: [{ text: "Pass a projectId from list_projects." }] });
	expect(await call("get_status", { projectId: "missing" })).toMatchObject({ isError: true });
	expect(await call("plan_silence_cuts", { projectId: "demo", pad: -1 })).toMatchObject({ isError: true });
	expect(await call("plan_silence_cuts", { projectId: "demo", ignoreMedia: ["a,b"] })).toMatchObject({ isError: true });
	expect((await rpc("tools/call", { name: "delete_everything" })).error).toMatchObject({ code: -32602 });
	expect((await rpc("resources/list")).error).toMatchObject({ code: -32601 });
});

test("only local clients reach the endpoint, with POST and valid JSON-RPC", async () => {
	expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://evil.example" })).status).toBe(403);
	expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "http://192.168.1.5:3000/api/mcp")).status).toBe(403);
	expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
	expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://127.0.0.1:3000" })).status).toBe(200);
	expect((await handleMcp(new Request("http://127.0.0.1:3000/api/mcp"), workspace)).status).toBe(405);
	const broken = await post("{ not json");
	expect(broken.status).toBe(400);
	expect((await broken.json()).error.code).toBe(-32700);
	expect((await (await post({ id: 1, method: "ping" })).json()).error.code).toBe(-32600);
});

test("submit_draft writes draft.json for the editor and says when no editor has the project open", async () => {
	const ops = [{ op: "cut", start: 63 / 30, end: 87 / 30 }, { op: "cut", start: 0, end: 27 / 30 }];
	const sent = await call("submit_draft", { projectId: "demo", ops, label: " Cut dead air ", basedOn: "2026-11-26T10:00:00.000Z", atomic: true });
	expect(sent.isError).toBeUndefined();
	const { rev } = sent.structuredContent;
	expect(rev).toMatch(/^mcp-[\w-]+$/);
	expect(await readWorkspace("draft.json")).toEqual({ schema: "opencut-agent-draft-1", rev, projectId: "demo",
		label: "Cut dead air", basedOn: "2026-11-26T10:00:00.000Z", atomic: true, ops });
	expect(sent.structuredContent).toMatchObject({ rev, projectId: "demo", answered: false, editorOpen: false });
	expect(sent.structuredContent.message).toContain("Ask the person to open the project in the editor");
	expect(JSON.parse(sent.content[0].text)).toEqual(sent.structuredContent);
	const later = await call("get_draft_result", { projectId: "demo", rev, waitSeconds: 30 });
	expect(later.structuredContent).toMatchObject({ rev, answered: false, editorOpen: false });
});

test("with the project open, submit_draft returns the editor's result, and a refused draft is a tool error", async () => {
	let draft: Record<string, unknown> = {};
	options = { waitMs: 5000, editorOpen: async () => {
		draft = await editorAnswers({ applied: true, saved: true, savedAt: "2026-11-26T10:00:03.000Z", results: [{ op: "cut", ok: true }] });
		return true;
	} };
	const applied = await call("submit_draft", { projectId: "demo", ops: [{ op: "cut", start: 0, end: 0.9 }] });
	expect(applied.isError).toBeUndefined();
	expect(applied.structuredContent).toMatchObject({ rev: draft.rev, answered: true, applied: true,
		message: `Draft ${draft.rev} applied as one Undo step and was saved.`, result: { saved: true, results: [{ op: "cut", ok: true }] } });
	expect(await fs.readdir(path.join(workspace, "drafts-applied"))).toEqual([expect.stringMatching(new RegExp(`^${draft.rev}-\\d+\\.json$`))]);
	expect((await call("get_draft_result", { projectId: "demo", rev: draft.rev })).structuredContent).toMatchObject({ answered: true, applied: true });

	options = { waitMs: 5000, editorOpen: async () => {
		await editorAnswers({ applied: false, stale: true, error: "every op was stale; nothing was applied (re-read the snapshot and resend)" });
		return true;
	} };
	const stale = await call("submit_draft", { projectId: "demo", ops: [{ op: "delete", match: { agentId: "voice" } }], basedOn: "old" });
	expect(stale.isError).toBe(true);
	expect(stale.structuredContent).toMatchObject({ answered: true, applied: false });
	expect(stale.structuredContent.message).toContain("every op was stale");
	expect(stale.structuredContent.message).toContain("Read get_status again");
});

test("an open editor that has not applied the draft yet is waited for, then reported as still waiting", async () => {
	options = { waitMs: 0, editorOpen: async () => true };
	const sent = await call("submit_draft", { projectId: "demo", ops: [{ op: "cut", start: 0, end: 0.9 }] });
	expect(sent.structuredContent).toMatchObject({ answered: false, editorOpen: true });
	expect(sent.structuredContent.message).toContain("has not applied after 0 s");
	const waited = call("get_draft_result", { projectId: "demo", rev: sent.structuredContent.rev, waitSeconds: 5 });
	await new Promise((resolve) => setTimeout(resolve, 200));
	await editorAnswers({ applied: true, saved: false, saveError: "disk full" });
	expect((await waited).structuredContent).toMatchObject({ answered: true, applied: true,
		message: `Draft ${sent.structuredContent.rev} applied as one Undo step; the project is not saved yet: disk full.` });
});

test("a draft that has not applied yet is kept as superseded when a new one replaces it", async () => {
	await fs.writeFile(path.join(workspace, "draft.json"), JSON.stringify({ schema: "opencut-agent-draft-1", rev: "older", projectId: "other", ops: [] }));
	const sent = await call("submit_draft", { projectId: "demo", ops: [{ op: "cut", start: 0, end: 0.9 }] });
	expect(sent.structuredContent.replacedDraft).toEqual({ rev: "older", projectId: "other" });
	const [kept] = await fs.readdir(path.join(workspace, "drafts-applied"));
	expect(kept).toMatch(/^superseded-/);
	expect((await readWorkspace(path.join("drafts-applied", kept))).rev).toBe("older");
	expect((await readWorkspace("draft.json")).rev).toBe(sent.structuredContent.rev);
	const gone = await call("get_draft_result", { projectId: "demo", rev: "older" });
	expect(gone.isError).toBe(true);
	expect(gone.content[0].text).toContain("is not waiting in draft.json");
	const otherProject = await call("get_draft_result", { projectId: "other", rev: sent.structuredContent.rev });
	expect(otherProject).toMatchObject({ isError: true, content: [{ text: `Draft ${sent.structuredContent.rev} belongs to project demo.` }] });
});

test("invalid drafts are refused before anything is written", async () => {
	const refused = async (args: Record<string, unknown>, message: string) => {
		expect(await call("submit_draft", { projectId: "demo", ops: [{ op: "cut", start: 0, end: 1 }], ...args }))
			.toMatchObject({ isError: true, content: [{ text: expect.stringContaining(message) }] });
	};
	await refused({ ops: [] }, "Pass ops as a list");
	await refused({ ops: [{ start: 1 }] }, "each with its \"op\"");
	await refused({ ops: "cut" }, "Pass ops as a list");
	await refused({ projectId: "missing" }, "Project was not found on disk");
	await refused({ onConflict: "maybe" }, "keep or refuse");
	await refused({ basedOn: " " }, "syncedAt");
	await refused({ label: "" }, "label");
	expect(await fs.readdir(workspace)).not.toContain("draft.json");
	expect(await call("get_draft_result", { projectId: "demo", rev: "../draft" })).toMatchObject({ isError: true });
	expect(await call("get_draft_result", { projectId: "demo", rev: "mcp-x", waitSeconds: 99 })).toMatchObject({ isError: true });
});

test("without a stub, the server asks its own agent routes whether the project is open", async () => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handleCli(req, "presence", workspace) });
	try {
		options = { waitMs: 0 };
		const endpoint = `http://127.0.0.1:${server.port}/api/mcp`;
		const closed = await call("submit_draft", { projectId: "demo", ops: [{ op: "cut", start: 0, end: 0.9 }] }, endpoint);
		expect(closed.structuredContent).toMatchObject({ answered: false, editorOpen: false });
		// An editor tab of the project asks for agent requests every 2 s.
		renderPresence(new Request("http://127.0.0.1:3000/api/agent/changes-request", { headers: { "x-bopencut-project": "demo" } }));
		const open = await call("get_draft_result", { projectId: "demo", rev: closed.structuredContent.rev, waitSeconds: 0 }, endpoint);
		expect(open.structuredContent).toMatchObject({ answered: false, editorOpen: true });
	} finally {
		server.stop(true);
	}
});
