import { parseArgs as parse } from "node:util";
import path from "node:path";
import { parseExportRequest } from "../src/agent/export";
import { parseFrameInput } from "../src/agent/render-input";
import { parseRangeInput } from "../src/agent/range-view";
import { renderTimeoutMessage, waitingForRender } from "../src/agent/render-timeout";
import { captionLanguage, getTranscript, type TranscriptRequest } from "../src/retrieval/transcript";
import { isHttpUrl, parseTime } from "../src/retrieval/time";
import { runRender } from "./agent-render";
import { loadEnvLocal } from "./retrieval-cli";

const commands = ["status", "selection", "notes", "export", "frames", "transcript", "transcript-view", "view", "review"] as const;
type Command = typeof commands[number];
const usage = "Use: bun run agent <status|selection|notes|export|frames|transcript|transcript-view|view|review> [--project-id ID] [--timeout SECONDS]";
const transcriptUsage = "Use: bun run agent transcript <url> [--lang CODE] [--range START-END] [--timeout S] [--project-id ID]";

/** Renders report progress at most every two seconds, so a shorter stall limit would stop a working job. */
export const minRenderTimeout = 10;

export function parseArgs(args: string[], minRenderSeconds = minRenderTimeout) {
	const [command, ...rest] = args;
	if (!commands.some((supported) => supported === command)) throw new Error(usage);
	if (command === "frames" && rest.some((arg) => /^--(?:state|compare)(?:=|$)/.test(arg))) {
		throw new Error("For historical or comparison frames, open the editor and use frames-request.json.");
	}
	const render = command === "export" || command === "frames" || command === "view";
	const transcript = command === "transcript";
	const { values, positionals } = parse({
		args: rest, allowPositionals: transcript,
		options: {
			"project-id": { type: "string" }, timeout: { type: "string" },
			...(transcript && { lang: { type: "string" }, range: { type: "string" } }),
			...(!transcript && { url: { type: "string" } }),
			...(render && command !== "view" && { "allow-missing": { type: "boolean" } }),
			...(command === "view" && { from: { type: "string" }, to: { type: "string" }, rows: { type: "string" }, file: { type: "string" } }),
			...(command === "review" && { file: { type: "string" }, pictures: { type: "string" } }),
			...(command === "transcript-view" && { media: { type: "string" }, timeline: { type: "boolean" } }),
			...(command === "export" && { name: { type: "string" }, format: { type: "string" }, quality: { type: "string" }, fps: { type: "string" } }),
			...(command === "frames" && { times: { type: "string" }, width: { type: "string" }, element: { type: "string", multiple: true }, elements: { type: "string" }, note: { type: "string" }, "scene-id": { type: "string" } }),
		},
	});
	const seconds = Number(values.timeout ?? (render ? 600 : command === "review" ? 180 : 30));
	if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86400) throw new Error("Set --timeout to a positive number of seconds, up to 86400.");
	if (render && !values.file && seconds < minRenderSeconds) throw new Error(`Set --timeout to at least ${minRenderSeconds} seconds for a render.`);
	const projectId = values["project-id"];
	if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("Pass a valid project ID to --project-id.");
	const timeoutMs = Math.round(seconds * 1000);
	const media = typeof values.media === "string" ? values.media : undefined;
	if (command === "transcript-view" && (!projectId || (media !== undefined && (!media.trim() || values.timeline)))) {
		throw new Error("Use transcript-view --project-id ID [--media NAME | --timeline].");
	}
	const file = typeof values.file === "string" ? values.file : undefined;
	const rangeView = command === "view" ? parseRangeInput({
		from: typeof values.from === "string" && values.from.trim() ? Number(values.from) : undefined,
		to: typeof values.to === "string" && values.to.trim() ? Number(values.to) : undefined,
		rows: values.rows === undefined ? undefined : Number(values.rows),
	}) : undefined;
	if (rangeView && ((file !== undefined) === !!projectId || file === "")) {
		throw new Error("Use view with either --project-id ID or --file PATH.");
	}
	if (rangeView && file) return { command: "file-view" as const, file, rangeView, timeoutMs };
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
		const request: TranscriptRequest = { url, language, range };
		return { command: "transcript" as const, projectId, timeoutMs, request };
	}
	const server = typeof values.url === "string" ? values.url : process.env.BOPENCUT_URL;
	const url = URL.parse(server ?? "http://127.0.0.1:3000");
	if (!url || !["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Set --url to the local editor origin, for example http://127.0.0.1:3000.");
	}
	if (command === "review") {
		if (!projectId || !file?.trim() || (values.pictures !== undefined && values.pictures !== "none")) {
			throw new Error("Use review --project-id ID --file PATH [--pictures none].");
		}
		return { command: "review" as const, projectId, file, pictures: values.pictures !== "none", origin: url.origin,
			timeoutMs: values.timeout === undefined ? undefined : timeoutMs };
	}
	let request: Record<string, unknown> | undefined;
	if (rangeView) request = rangeView;
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
		request = parseFrameInput({ times, elements, noteId: values.note, sceneId: values["scene-id"], width: values.width === undefined ? undefined : Number(values.width), allowMissing });
	}
	return { command: command as Exclude<Command, "transcript" | "review">, projectId, timeoutMs, origin: url.origin,
		...(media !== undefined && { media }), ...(request && { request }) };
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

export async function main(args: string[], minRenderSeconds = minRenderTimeout) {
	const options = parseArgs(args, minRenderSeconds);
	if (options.command === "transcript") return transcriptCommand(options.request, options.timeoutMs);
	if (options.command === "review") {
		const target = new URL("/api/agent/cli/review", options.origin);
		target.searchParams.set("projectId", options.projectId);
		const stop = new AbortController();
		const cancel = () => stop.abort(new Error("Review interrupted."));
		process.on("SIGINT", cancel);
		process.on("SIGTERM", cancel);
		try {
			const response = await fetch(target, { method: "POST", redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file: options.file, pictures: options.pictures, timeoutMs: options.timeoutMs }),
				signal: options.timeoutMs === undefined ? stop.signal : AbortSignal.any([stop.signal, AbortSignal.timeout(options.timeoutMs + 2000)]) });
			const result = await response.json();
			if (!response.ok) throw new Error(result?.error ?? "Could not review the export.");
			return result;
		} finally {
			process.removeListener("SIGINT", cancel);
			process.removeListener("SIGTERM", cancel);
		}
	}
	if (options.command === "file-view") {
		const webDir = path.resolve(import.meta.dir, "..");
		loadEnvLocal(path.join(webDir, ".env.local"));
		const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
		const interrupt = new AbortController();
		const deadline = AbortSignal.timeout(options.timeoutMs);
		const stop = () => interrupt.abort(new Error("Interrupted by Ctrl+C."));
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			const { fileRangeView } = await import("./agent-file-view");
			return await fileRangeView(options.file, options.rangeView, workspace, path.resolve(process.env.AGENT_FILES_ROOT ?? workspace),
				AbortSignal.any([interrupt.signal, deadline]));
		} catch (error) {
			if (deadline.aborted) throw new Error("Timed out while making the file range view. Increase --timeout and retry.");
			interrupt.signal.throwIfAborted();
			if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
				throw new Error(`FFmpeg could not read the range: ${error.stderr.trim().split(/\r?\n/).slice(0, 2).join(" ")}`, { cause: error });
			}
			throw error;
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
		}
	}
	const { command, projectId, timeoutMs, origin, request } = options;
	const target = new URL(`/api/agent/cli/${request ? "render" : command}`, origin);
	if (projectId) target.searchParams.set("projectId", projectId);
	if (options.media !== undefined) target.searchParams.set("media", options.media);
	const interrupt = new AbortController();
	const stop = () => interrupt.abort(new Error("Interrupted by Ctrl+C."));
	if (request) process.on("SIGINT", stop);
	const connection = new AbortController();
	const deadline = request && setTimeout(() => connection.abort(new Error(renderTimeoutMessage(timeoutMs, waitingForRender))), timeoutMs);
	const signal = request ? AbortSignal.any([connection.signal, interrupt.signal]) : AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(target, {
			signal, redirect: "error",
			...(request && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, request, timeoutMs }) }),
		}).catch(() => {
			signal.throwIfAborted();
			throw new Error(`Cannot reach the editor at ${origin}. Start it from apps/web with bunx next dev --turbopack -H 127.0.0.1 -p ${target.port || "80"}, then retry.`);
		});
		if (deadline && response.ok) {
			clearTimeout(deadline);
			return await runRender(response, { signal: interrupt.signal, timeoutMs });
		}
		if (response.ok && command === "transcript-view") return await response.text();
		const body = await response.json().catch(() => null);
		signal.throwIfAborted();
		if (!response.ok || !body) throw new Error(body?.error ?? "The server did not answer the agent CLI. Start this version of the editor and retry.");
		return body;
	} catch (error) {
		if (signal.aborted && !request) throw new Error("Timed out while reading from the editor. Check the server or increase --timeout.");
		throw error;
	} finally {
		if (deadline) clearTimeout(deadline);
		process.removeListener("SIGINT", stop);
	}
}

export function renderFailed(command: string, result: Record<string, unknown>) {
	return !!result.error || result.status === "error" || (command === "frames" && Array.isArray(result.files) && !result.files.length && Array.isArray(result.errors) && result.errors.length > 0);
}

if (import.meta.main) {
	try {
		const result = await main(process.argv.slice(2));
		if (typeof result === "string") process.stdout.write(result);
		else console.log(JSON.stringify(result));
		if (typeof result !== "string" && renderFailed(process.argv[2], result)) {
			console.error(String(result.error ?? "No requested frame could be rendered.").replace(/\s+/g, " "));
			process.exitCode = 1;
		}
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
		console.error(message);
		if (!["export", "frames", "transcript", "transcript-view", "view"].includes(process.argv[2])) console.log(JSON.stringify({ error: message }));
		process.exitCode = 1;
	}
}
