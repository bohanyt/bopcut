import { afterAll, beforeAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture } from "@/timeline/__tests__/compound-fixtures";
import { handleMcp, MCP_TOOLS } from "./mcp";

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

const post = (body: unknown, headers: Record<string, string> = {}, url = "http://127.0.0.1:3000/api/mcp") =>
	handleMcp(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body) }), workspace);
const rpc = async (method: string, params?: unknown) => (await post({ jsonrpc: "2.0", id: 1, method, params })).json();
const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result;

test("initialize negotiates the protocol version and lists the read-only tools", async () => {
	const known = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	expect(known.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bopcut" } });
	expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
	expect((await rpc("ping")).result).toEqual({});
	const { tools } = (await rpc("tools/list")).result;
	expect(tools.map(({ name }: { name: string }) => name)).toEqual(MCP_TOOLS.map(({ name }) => name));
	for (const tool of tools) expect(tool).toMatchObject({ inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
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
