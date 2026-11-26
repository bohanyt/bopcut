import { promises as fs } from "node:fs";
import path from "node:path";
import { EXPORT_FORMAT_VALUES, EXPORT_QUALITY_VALUES } from "@/export";
import { dataRoot } from "@/services/storage/server/files";
import { readProjectSummary } from "@/services/storage/server/projects";
import { handleCli } from "./cli-api";
import { launchBrowser } from "./hidden-browser";
import { type DraftContext, draftResult, MAX_DRAFT_OPS, MAX_DRAFT_WAIT_SECONDS, submitDraft } from "./mcp-drafts";
import { cancelJob, exportVideo, type JobAnswer, type JobContext, jobStatus, MAX_JOB_WAIT_SECONDS, renderFrames } from "./mcp-jobs";
import { isForeignOrigin } from "./origin";
import { MAX_FRAMES } from "./render-input";

/**
 * A Model Context Protocol server over Streamable HTTP, stateless with JSON answers (no event
 * stream). The tools reuse the agent CLI handlers, so their checks and messages are the same.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "bopcut", title: "bopcut video editor", version: "0.1.0" };
const INSTRUCTIONS = "Tools for a local bopcut editor: list projects, then read a project's status, notes, " +
	"selection and timeline transcript, and plan dead-air cuts. Times are seconds on the root timeline. " +
	"Change a project with submit_draft: its ops apply in the open editor as one Undo step, which the person can undo. " +
	"Put the snapshot's syncedAt from get_status in basedOn, so ops on clips the person changed since are refused. " +
	"Look at the result with get_frames and export it with export_video; both run as jobs that get_job follows.";

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Args = Record<string, unknown>;

const projectId = { type: "string", description: "Project ID from list_projects." };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Clients ask the person before a tool that changes a project. Draft assets can come from links. */
const changesProject = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** Renders write new files into the workspace and leave the project as it is. */
const writesFiles = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const jobId = { type: "string", description: "The jobId that export_video or get_frames returned." };
/** Pictures for a client to look at: smaller than a full frame unless asked for. */
const MCP_FRAME_WIDTH = 960;

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
	{
		name: "submit_draft", title: "Send a draft",
		description: "Changes a project: the editor applies the ops in order as one Undo step and selects what changed. " +
			"The ops are those of draft.json in the bopcut agent guide (AGENT.md), such as set, delete, add, cut, animate and note; " +
			"the ops of plan_silence_cuts go in as they are. Drafts apply only while the project is open in the editor. " +
			"Waits a few seconds for the result; get_draft_result reads it later.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId", "ops"],
			properties: {
				projectId,
				ops: {
					type: "array", minItems: 1, maxItems: MAX_DRAFT_OPS, description: "Draft ops, applied in order.",
					items: { type: "object", required: ["op"], properties: { op: { type: "string" } } },
				},
				label: { type: "string", maxLength: 200, description: "Short name the editor shows when the draft applies, such as Cut dead air." },
				basedOn: { type: "string", description: "The syncedAt of the get_status snapshot the ops were planned from. Ops on clips the person changed since are refused." },
				atomic: { type: "boolean", description: "Apply every op or none." },
				onConflict: { type: "string", enum: ["keep", "refuse"], description: "keep: leave the fields the person changed since basedOn and apply the rest." },
			},
		},
		annotations: changesProject,
	},
	{
		name: "get_draft_result", title: "Draft result",
		description: "Whether a draft from submit_draft applied and was saved, with the editor's result for each op, or why it is still waiting. " +
			"Waits for the result while the project is open in the editor.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId", "rev"],
			properties: {
				projectId,
				rev: { type: "string", description: "The rev that submit_draft returned." },
				waitSeconds: { type: "number", minimum: 0, maximum: MAX_DRAFT_WAIT_SECONDS, description: "Longest wait for the open editor (default 15)." },
			},
		},
		annotations: readOnly,
	},
	{
		name: "export_video", title: "Export the video",
		description: "Renders the root timeline to a video file in the workspace's exports folder, in an open editor tab of the project " +
			"or in a hidden browser. Answers within about 20 s with the file's path, or with a jobId to follow with get_job while it renders.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId"],
			properties: {
				projectId,
				name: { type: "string", maxLength: 80, description: "File name without extension (default: the project name). A name in use gets a number." },
				format: { type: "string", enum: [...EXPORT_FORMAT_VALUES], description: "Default mp4." },
				quality: { type: "string", enum: [...EXPORT_QUALITY_VALUES], description: "Default very_high." },
				fps: { type: "number", minimum: 1, maximum: 240, description: "Frame rate (default: the project's)." },
				allowMissing: { type: "boolean", description: "Export even when media files are missing." },
			},
		},
		annotations: writesFiles,
	},
	{
		name: "get_frames", title: "Look at frames",
		description: "Renders frames of the root timeline and returns them as JPEG pictures to look at, with their paths: at times in seconds, " +
			"at the start of clips (elements), or at a note. Pass one of times, elements or noteId. Runs as a job like export_video.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["projectId"],
			properties: {
				projectId,
				times: { type: "array", minItems: 1, maxItems: MAX_FRAMES, items: { type: "number", minimum: 0 }, description: "Root timeline seconds." },
				elements: { type: "array", minItems: 1, maxItems: MAX_FRAMES, items: { type: "string" }, description: "Clip IDs or agent IDs from get_status." },
				noteId: { type: "string", description: "A note from get_notes; an area note also gives a crop of its box." },
				sceneId: { type: "string", description: "The note's scene, when its ID is shared by copies." },
				width: { type: "integer", minimum: 1, maximum: 4096, description: `Picture width in pixels (default ${MCP_FRAME_WIDTH}).` },
				allowMissing: { type: "boolean", description: "Render even when media files are missing." },
			},
		},
		annotations: writesFiles,
	},
	{
		name: "get_job", title: "Job progress",
		description: "The stage of an export or frames job, or its result once it is done (the video's path, or the frames as pictures). " +
			"Waits up to waitSeconds for it to finish.",
		inputSchema: {
			type: "object", additionalProperties: false, required: ["jobId"],
			properties: { jobId, waitSeconds: { type: "number", minimum: 0, maximum: MAX_JOB_WAIT_SECONDS, description: "Longest wait (default 20)." } },
		},
		annotations: readOnly,
	},
	{
		name: "cancel_job", title: "Cancel a job",
		description: "Stops an export or frames job that is still running; nothing is saved from it.",
		inputSchema: { type: "object", additionalProperties: false, required: ["jobId"], properties: { jobId } },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
] as const;

const text = (value: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: value }], ...extra });
const failure = (message: string) => text(message, { isError: true });
const structured = ({ value, isError, pictures = [] }: JobAnswer) => ({
	...text(JSON.stringify(value), { structuredContent: value, ...(isError && { isError }) }),
	...(pictures.length && { content: [{ type: "text" as const, text: JSON.stringify(value) },
		...pictures.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" as const }))] }),
});

/** How long submit_draft waits for the open editor to apply a draft (it looks every 2 s). */
const DRAFT_WAIT_MS = 15_000;
/** How long a render tool waits before it answers with its job: a short one is done by then. */
const JOB_WAIT_MS = 20_000;
type ToolContext = DraftContext & JobContext;
export type McpOptions = Partial<Pick<ToolContext, "editorOpen" | "waitMs" | "launch" | "jobWaitMs">>;

/**
 * The open tabs are known to the agent routes, so they are asked over HTTP, as the CLI asks them,
 * whichever module copy this route has.
 */
async function askEditorOpen(origin: string, projectId: string, signal: AbortSignal) {
	const url = new URL("/api/agent/cli/presence", origin);
	url.searchParams.set("projectId", projectId);
	try {
		const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
		return (await response.json())?.open === true;
	} catch {
		return false;
	}
}

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

async function callTool(name: string, args: Args, context: ToolContext): Promise<ToolResult> {
	const { workspace, signal } = context;
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
		case "submit_draft": return structured(await submitDraft(args, requireProject(args), context));
		case "get_draft_result": return structured(await draftResult(args, requireProject(args), context));
		case "export_video": return structured(await exportVideo(args, requireProject(args), context));
		case "get_frames": return structured(await renderFrames({ width: MCP_FRAME_WIDTH, ...args }, requireProject(args), context));
		case "get_job": return structured(await jobStatus(args, context));
		case "cancel_job": return structured(await cancelJob(args, context));
		default: throw new UnknownTool(name);
	}
}

class UnknownTool extends Error {}

function rpcError(id: JsonRpcId, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

async function answer(message: JsonRpcMessage, context: ToolContext) {
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
				return { jsonrpc: "2.0", id, result: await callTool(name, args, context) };
			} catch (error) {
				if (error instanceof UnknownTool) return rpcError(id, -32602, `Unknown tool: ${name}`);
				return { jsonrpc: "2.0", id, result: failure(error instanceof Error ? error.message : String(error)) };
			}
		}
		default: return rpcError(id, -32601, `Method not found: ${message.method}`);
	}
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function handleMcp(req: Request, workspace: string, options: McpOptions = {}): Promise<Response> {
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
	const context: ToolContext = {
		workspace, signal: req.signal, origin: url.origin, waitMs: options.waitMs ?? DRAFT_WAIT_MS,
		editorOpen: options.editorOpen ?? ((projectId) => askEditorOpen(url.origin, projectId, req.signal)),
		launch: options.launch ?? launchBrowser, jobWaitMs: options.jobWaitMs ?? JOB_WAIT_MS,
	};
	const answers = [];
	for (const message of requests) answers.push(await answer(message, context));
	return json(Array.isArray(body) ? answers : answers[0]);
}
