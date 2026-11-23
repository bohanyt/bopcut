import { parseArgs as parse } from "node:util";
import path from "node:path";
import { parseExportRequest } from "../src/agent/export";
import { parseFrameInput } from "../src/agent/render-input";
import { captionLanguage, getTranscript, type TranscriptRequest } from "../src/retrieval/transcript";
import { isHttpUrl, parseTime } from "../src/retrieval/time";
import { runRender } from "./agent-render";
import { loadEnvLocal } from "./retrieval-cli";

const commands = ["status", "selection", "notes", "export", "frames", "transcript"] as const;
type Command = typeof commands[number];
const usage = "Use: bun run agent <status|selection|notes|export|frames|transcript> [--project-id ID] [--timeout SECONDS]";
const transcriptUsage = "Use: bun run agent transcript <url> [--lang CODE] [--range START-END] [--refresh] [--timeout S] [--project-id ID]";

export function parseArgs(args: string[]) {
	const [command, ...rest] = args;
	if (!commands.some((supported) => supported === command)) throw new Error(usage);
	if (command === "frames" && rest.some((arg) => /^--(?:state|compare)(?:=|$)/.test(arg))) {
		throw new Error("For historical or comparison frames, open the editor and use frames-request.json.");
	}
	const render = command === "export" || command === "frames";
	const transcript = command === "transcript";
	const { values, positionals } = parse({
		args: rest, allowPositionals: transcript,
		options: {
			"project-id": { type: "string" }, timeout: { type: "string" },
			...(transcript && { lang: { type: "string" }, range: { type: "string" }, refresh: { type: "boolean" } }),
			...(!transcript && { url: { type: "string" } }),
			...(render && { "allow-missing": { type: "boolean" } }),
			...(command === "export" && { name: { type: "string" }, format: { type: "string" }, quality: { type: "string" }, fps: { type: "string" } }),
			...(command === "frames" && { times: { type: "string" }, width: { type: "string" }, element: { type: "string", multiple: true }, elements: { type: "string" } }),
		},
	});
	const seconds = Number(values.timeout ?? (render ? 600 : 30));
	if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86400) throw new Error("Set --timeout to a positive number of seconds, up to 86400.");
	const projectId = values["project-id"];
	if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("Pass a valid project ID to --project-id.");
	const timeoutMs = Math.round(seconds * 1000);
	if (transcript) {
		const [url] = positionals;
		if (positionals.length !== 1) throw new Error(transcriptUsage);
		if (!isHttpUrl(url)) throw new Error("Pass an http(s) video link.");
		const language = typeof values.lang === "string" ? values.lang : undefined;
		if (language !== undefined && !captionLanguage.test(language)) throw new Error("Pass a caption language code to --lang.");
		let range;
		if (typeof values.range === "string") {
			const parts = values.range.split("-");
			const [start, end] = parts.map(parseTime);
			if (parts.length !== 2 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
				throw new Error("Pass --range START-END with increasing source times.");
			}
			range = { start, end };
		}
		const request: TranscriptRequest = { url, language, range, refresh: values.refresh === true };
		return { command: "transcript" as const, projectId, timeoutMs, request };
	}
	const server = typeof values.url === "string" ? values.url : process.env.BOPENCUT_URL;
	const url = URL.parse(server ?? "http://127.0.0.1:3000");
	if (!url || !["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Set --url to the local editor origin, for example http://127.0.0.1:3000.");
	}
	let request: Record<string, unknown> | undefined;
	const allowMissing = values["allow-missing"] === true;
	if (command === "export") {
		const parsed = parseExportRequest({ rev: "cli", name: values.name, format: values.format, quality: values.quality, fps: values.fps === undefined ? undefined : Number(values.fps), allowMissing });
		if (!parsed || typeof parsed === "string") throw new Error(parsed ?? "Invalid export.");
		const { rev: _rev, ...options } = parsed;
		request = options;
	}
	if (command === "frames") {
		const times = typeof values.times === "string" ? values.times.split(",").map((time) => time.trim() ? Number(time) : NaN) : undefined;
		const elements = Array.isArray(values.element) || typeof values.elements === "string"
			? [...(Array.isArray(values.element) ? values.element : []), ...(typeof values.elements === "string" ? values.elements.split(",") : [])] : undefined;
		request = parseFrameInput({ times, elements, width: values.width === undefined ? undefined : Number(values.width), allowMissing });
	}
	return { command: command as Exclude<Command, "transcript">, projectId, timeoutMs, origin: url.origin, ...(request && { request }) };
}

async function transcriptCommand(request: TranscriptRequest, timeoutMs: number) {
	const webDir = path.resolve(import.meta.dir, "..");
	loadEnvLocal(path.join(webDir, ".env.local"));
	const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([deadline, controller.signal]);
	let stage = "preparing transcript";
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		return await getTranscript(request, { workspace, filesRoot: process.env.AGENT_FILES_ROOT, signal, progress: (next) => {
			stage = next;
			console.error(JSON.stringify({ stage }));
		} });
	} catch (error) {
		if (deadline.aborted) throw new Error(`Timed out while ${stage}. Increase --timeout and retry.`);
		if (controller.signal.aborted) throw new Error(`Interrupted while ${stage}. Retry the command to start again.`);
		throw error;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
}

async function main(args: string[]) {
	const options = parseArgs(args);
	if (options.command === "transcript") return transcriptCommand(options.request, options.timeoutMs);
	const { command, projectId, timeoutMs, origin, request } = options;
	const target = new URL(`/api/agent/cli/${request ? "render" : command}`, origin);
	if (projectId) target.searchParams.set("projectId", projectId);
	const interrupt = new AbortController();
	const stop = () => interrupt.abort(new Error("Interrupted by Ctrl+C."));
	if (request) process.on("SIGINT", stop);
	const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), interrupt.signal]);
	try {
		const response = await fetch(target, {
			signal, redirect: "error",
			...(request && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, request, timeoutMs }) }),
		}).catch(() => {
			signal.throwIfAborted();
			throw new Error(`Cannot reach the editor at ${origin}. Start it from apps/web with bunx next dev --turbopack -H 127.0.0.1 -p ${target.port || "80"}, then retry.`);
		});
		if (request && response.ok) return await runRender(response, { signal });
		const body = await response.json().catch(() => null);
		signal.throwIfAborted();
		if (!response.ok || !body) throw new Error(body?.error ?? "The server did not answer the agent CLI. Start this version of the editor and retry.");
		return body;
	} catch (error) {
		if (signal.aborted && !request) throw new Error("Timed out while reading from the editor. Check the server or increase --timeout.");
		if (request && error === signal.reason && signal.reason?.name === "TimeoutError") throw new Error("Timed out while waiting for a tab.");
		throw error;
	} finally {
		process.removeListener("SIGINT", stop);
	}
}

export function renderFailed(command: string, result: Record<string, unknown>) {
	return !!result.error || result.status === "error" || (command === "frames" && Array.isArray(result.files) && !result.files.length && Array.isArray(result.errors) && result.errors.length > 0);
}

if (import.meta.main) {
	try {
		const result = await main(process.argv.slice(2));
		console.log(JSON.stringify(result));
		if (renderFailed(process.argv[2], result)) {
			console.error(String(result.error ?? "No requested frame could be rendered.").replace(/\s+/g, " "));
			process.exitCode = 1;
		}
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
		console.error(message);
		if (!["export", "frames", "transcript"].includes(process.argv[2])) console.log(JSON.stringify({ error: message }));
		process.exitCode = 1;
	}
}
