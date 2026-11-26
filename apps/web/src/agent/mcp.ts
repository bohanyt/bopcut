import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot } from "@/services/storage/server/files";
import { readProjectSummary } from "@/services/storage/server/projects";
import { handleCli } from "./cli-api";
import { isForeignOrigin } from "./origin";

/**
 * A Model Context Protocol server over Streamable HTTP, stateless with JSON answers (no event
 * stream). The tools reuse the agent CLI handlers, so their checks and messages are the same.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "bopencut", title: "bopencut video editor", version: "0.1.0" };
const INSTRUCTIONS = "Tools for a local bopencut editor: list projects, then read a project's status, notes, " +
	"selection and timeline transcript, and plan dead-air cuts. Times are seconds on the root timeline. " +
	"The plans return draft ops; this server does not change projects yet.";

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Args = Record<string, unknown>;

const projectId = { type: "string", description: "Project ID from list_projects." };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const MCP_TOOLS = [
	{
		name: "list_projects", title: "List projects",
		description: "Projects saved in this editor, newest first, with their IDs, names and last change.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: readOnly,
	},
	{
		name: "get_status", title: "Project status",
		description: "The latest timeline snapshot of a project: tracks, clips with times and agent IDs, and whether it is ready for drafts.",
		inputSchema: { type: "object", properties: { projectId }, required: ["projectId"], additionalProperties: false },
		annotations: readOnly,
	},
	{
		name: "get_notes", title: "Project notes",
		description: "Notes the person left on ranges, clips or areas of the picture, with replies.",
		inputSchema: { type: "object", properties: { projectId }, required: ["projectId"], additionalProperties: false },
		annotations: readOnly,
	},
	{
		name: "get_selection", title: "Current selection",
		description: "What the person selected last in the editor (clips, keyframes or a range), optionally only for one project.",
		inputSchema: { type: "object", properties: { projectId }, additionalProperties: false },
		annotations: readOnly,
	},
	{
		name: "read_transcript", title: "Read the transcript",
		description: "Stored words of the saved timeline as phrases with timeline and source seconds, or of one media file when media is given.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId"],
			properties: { projectId, media: { type: "string", description: "A media name or ID for the whole source instead of the timeline." } },
		},
		annotations: readOnly,
	},
	{
		name: "plan_silence_cuts", title: "Plan dead-air cuts",
		description: "Frame-exact cut ops for pauses and filler sounds, from the stored words. Clips with sound but no words block cuts unless their media is ignored. The ops run from the last cut to the first and go into one draft as they are.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId"],
			properties: {
				projectId,
				minGap: { type: "number", minimum: 0.05, maximum: 10, description: "Shortest pause to cut, in seconds (default 0.4)." },
				pad: { type: "number", minimum: 0, maximum: 1, description: "Seconds kept next to each word (default 0.08)." },
				keepFillers: { type: "boolean", description: "Do not cut filler sounds such as eh or umm." },
				keepLead: { type: "boolean", description: "Keep the silence before the first word." },
				tail: { type: "boolean", description: "Also cut the silence after the last word." },
				ignoreMedia: { type: "array", items: { type: "string" }, maxItems: 50, description: "Media names or IDs without words that cuts may run through, such as a music bed." },
			},
		},
		annotations: readOnly,
	},
] as const;

const text = (value: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: value }], ...extra });
const failure = (message: string) => text(message, { isError: true });

async function cli(action: string, query: Record<string, string>, workspace: string, signal: AbortSignal): Promise<ToolResult> {
	const url = new URL(`http://127.0.0.1/api/agent/cli/${action}`);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	const response = await handleCli(new Request(url, { signal }), action, workspace);
	const body = await response.text();
	if (response.headers.get("content-type")?.startsWith("text/plain")) return response.ok ? text(body) : failure(body);
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return failure(body || "The editor gave no answer.");
	}
	const error = value && typeof value === "object" && "error" in value ? String((value as { error: unknown }).error) : null;
	if (!response.ok || error) return failure(error ?? `The editor answered ${response.status}.`);
	return text(body, { structuredContent: value as Record<string, unknown> });
}

async function listProjects(): Promise<ToolResult> {
	const ids = await fs.readdir(path.join(dataRoot(), "projects")).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const projects = [];
	for (const id of ids.filter((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name))) {
		const summary = await readProjectSummary(id).catch(() => null);
		if (!summary) continue;
		const { name, updatedAt, createdAt } = summary.metadata;
		projects.push({ id, name, updatedAt, createdAt });
	}
	projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
	const result = { projects };
	return text(JSON.stringify(result), { structuredContent: result });
}

function requireProject(args: Args): string {
	const id = args.projectId;
	if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Pass a projectId from list_projects.");
	return id;
}

async function callTool(name: string, args: Args, workspace: string, signal: AbortSignal): Promise<ToolResult> {
	switch (name) {
		case "list_projects": return listProjects();
		case "get_status": return cli("status", { projectId: requireProject(args) }, workspace, signal);
		case "get_notes": return cli("notes", { projectId: requireProject(args) }, workspace, signal);
		case "get_selection":
			return cli("selection", args.projectId === undefined ? {} : { projectId: requireProject(args) }, workspace, signal);
		case "read_transcript": {
			const query: Record<string, string> = { projectId: requireProject(args) };
			if (args.media !== undefined) {
				if (typeof args.media !== "string" || !args.media.trim()) throw new Error("Pass media as a media name or ID.");
				query.media = args.media;
			}
			return cli("transcript-view", query, workspace, signal);
		}
		case "plan_silence_cuts": {
			const query: Record<string, string> = { projectId: requireProject(args) };
			for (const key of ["minGap", "pad"] as const) {
				if (args[key] === undefined) continue;
				if (typeof args[key] !== "number" || !Number.isFinite(args[key])) throw new Error(`Pass ${key} as a number of seconds.`);
				query[key] = String(args[key]);
			}
			if (args.keepFillers === true) query.fillers = "0";
			if (args.keepLead === true) query.lead = "0";
			if (args.tail === true) query.tail = "1";
			if (args.ignoreMedia !== undefined) {
				if (!Array.isArray(args.ignoreMedia) || args.ignoreMedia.some((entry) => typeof entry !== "string" || entry.includes(","))) {
					throw new Error("Pass ignoreMedia as a list of media names or IDs without commas.");
				}
				query.ignore = args.ignoreMedia.join(",");
			}
			return cli("silence-plan", query, workspace, signal);
		}
		default: throw new UnknownTool(name);
	}
}

class UnknownTool extends Error {}

function rpcError(id: JsonRpcId, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

async function answer(message: JsonRpcMessage, workspace: string, signal: AbortSignal) {
	const id = message.id ?? null;
	if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(id, -32600, "Invalid request");
	const params = (message.params && typeof message.params === "object" ? message.params : {}) as Args;
	switch (message.method) {
		case "initialize": {
			const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
			return { jsonrpc: "2.0", id, result: {
				protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
			} };
		}
		case "ping": return { jsonrpc: "2.0", id, result: {} };
		case "tools/list": return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
		case "tools/call": {
			const name = params.name;
			const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Args;
			if (typeof name !== "string") return rpcError(id, -32602, "Pass the tool name.");
			try {
				return { jsonrpc: "2.0", id, result: await callTool(name, args, workspace, signal) };
			} catch (error) {
				if (error instanceof UnknownTool) return rpcError(id, -32602, `Unknown tool: ${name}`);
				return { jsonrpc: "2.0", id, result: failure(error instanceof Error ? error.message : String(error)) };
			}
		}
		default: return rpcError(id, -32601, `Method not found: ${message.method}`);
	}
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function handleMcp(req: Request, workspace: string): Promise<Response> {
	const url = new URL(req.url);
	// Local clients only, and never a web page of another origin (DNS rebinding), as for the agent CLI.
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || isForeignOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site") {
		return json(rpcError(null, -32000, "Use the MCP endpoint of the local editor server."), 403);
	}
	if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json(rpcError(null, -32700, "Parse error"), 400);
	}
	const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
	if (!messages.length || messages.some((message) => !message || typeof message !== "object")) {
		return json(rpcError(null, -32600, "Invalid request"), 400);
	}
	// Notifications and responses from the client need no answer.
	const requests = messages.filter((message) => message.id !== undefined && message.method !== undefined);
	if (!requests.length) return new Response(null, { status: 202 });
	const answers = [];
	for (const message of requests) answers.push(await answer(message, workspace, req.signal));
	return json(Array.isArray(body) ? answers : answers[0]);
}
