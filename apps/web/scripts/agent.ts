import { parseArgs as parse } from "node:util";
import path from "node:path";
import type { DraftThresholds } from "../src/agent/draft-check";
import type { PictureOptions } from "../src/agent/draft-check-pictures";
import { parseExportRequest } from "../src/agent/export";
import { parseFrameInput } from "../src/agent/render-input";
import { parseRangeInput } from "../src/agent/range-view";
import { launchBrowser } from "../src/agent/hidden-browser";
import { renderFailed, runRender } from "../src/agent/render-client";
import { renderTimeoutMessage, waitingForRender } from "../src/agent/render-timeout";
import { captionLanguage, getTranscript, type TranscriptRequest } from "../src/retrieval/transcript";
import { isHttpUrl, parseTime } from "../src/retrieval/time";
import { loadEnvLocal } from "./retrieval-cli";

const commands = ["status", "selection", "notes", "export", "frames", "transcript", "transcript-view", "narration-plan", "view", "review", "draft-check", "voice", "silence-plan", "assemble"] as const;
type Command = typeof commands[number];
const usage = `Use: bun run agent <${commands.join("|")}> [--project-id ID] [--timeout SECONDS]`;
const transcriptUsage = "Use: bun run agent transcript <url> [--lang CODE] [--range START-END] [--timeout S] [--project-id ID]";

/** `--help` or `-h` anywhere, or `help` as the command: the usage is the answer, not an error. */
export function helpText(args: string[]): string | null {
	if (args[0] !== "help" && !args.some((arg) => arg === "--help" || arg === "-h")) return null;
	return `${args[0] === "transcript" ? transcriptUsage : usage}\n`;
}

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
			...(!transcript && command !== "draft-check" && command !== "voice" && { url: { type: "string" } }),
			...(command === "voice" && { name: { type: "string" }, text: { type: "string" }, "text-file": { type: "string" }, replace: { type: "boolean" } }),
			...(command === "assemble" && { script: { type: "string" }, plan: { type: "string" }, voices: { type: "string" }, gap: { type: "string" },
				start: { type: "string" }, "caption-preset": { type: "string" }, name: { type: "string" }, submit: { type: "boolean" } }),
			...(render && command !== "view" && { "allow-missing": { type: "boolean" } }),
			...(command === "view" && { from: { type: "string" }, to: { type: "string" }, rows: { type: "string" }, file: { type: "string" } }),
			...(command === "review" && { file: { type: "string" }, pictures: { type: "string" } }),
			...(command === "draft-check" && {
				from: { type: "string" }, to: { type: "string" }, json: { type: "boolean" }, all: { type: "boolean" },
				position: { type: "string" }, scale: { type: "string" }, rotation: { type: "string" }, opacity: { type: "string" },
				pictures: { type: "boolean" }, "picture-limit": { type: "string" }, "picture-distance": { type: "string" },
				"freeze-seconds": { type: "string" }, "outlier-distance": { type: "string" },
			}),
			...(command === "transcript-view" && { media: { type: "string" }, timeline: { type: "boolean" } }),
			...(command === "silence-plan" && { "min-gap": { type: "string" }, pad: { type: "string" }, "keep-fillers": { type: "boolean" },
				"keep-lead": { type: "boolean" }, tail: { type: "boolean" }, "ignore-media": { type: "string" },
				// The answer is always JSON; the flag is accepted like on the commands that also print text.
				json: { type: "boolean" } }),
			...(command === "narration-plan" && { clip: { type: "string" }, "new-media": { type: "string" },
				json: { type: "boolean" }, from: { type: "string" }, to: { type: "string" }, all: { type: "boolean" } }),
			...(command === "export" && { name: { type: "string" }, format: { type: "string" }, quality: { type: "string" }, fps: { type: "string" },
				size: { type: "string" }, preview: { type: "boolean" } }),
			...(command === "frames" && { times: { type: "string" }, width: { type: "string" }, element: { type: "string", multiple: true }, elements: { type: "string" }, note: { type: "string" }, "scene-id": { type: "string" } }),
		},
	});
	const seconds = Number(values.timeout ?? (render || command === "voice" ? 600 : command === "review" ? 180 : command === "draft-check" && values.pictures === true ? 55 : 30));
	if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86400) throw new Error("Set --timeout to a positive number of seconds, up to 86400.");
	if (render && !values.file && seconds < minRenderSeconds) throw new Error(`Set --timeout to at least ${minRenderSeconds} seconds for a render.`);
	const projectId = values["project-id"];
	if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("Pass a valid project ID to --project-id.");
	const timeoutMs = Math.round(seconds * 1000);
	if (command === "voice") {
		const text = typeof values.text === "string" ? values.text : undefined;
		const textFile = typeof values["text-file"] === "string" ? values["text-file"] : undefined;
		if (typeof values.name !== "string" || (text === undefined) === (textFile === undefined)) {
			throw new Error("Use voice --name NAME (--text TEXT | --text-file PATH) [--replace] [--timeout SECONDS].");
		}
		return { command: "voice" as const, input: { name: values.name, text, textFile, replace: values.replace === true }, timeoutMs };
	}
	if (command === "draft-check") {
		if (!projectId) throw new Error("Use draft-check --project-id ID [--from SECONDS] [--to SECONDS] [--json] [--all] [--pictures].");
		const number = (flag: "from" | "to" | keyof DraftThresholds | "picture-limit" | "picture-distance" | "freeze-seconds" | "outlier-distance") => {
			const value = values[flag];
			if (value === undefined) return;
			const parsed = Number(value);
			if (!String(value).trim() || !Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && flag !== "from")) {
				throw new Error(`Set --${flag} to ${flag === "from" ? "a nonnegative" : "a positive"} number.`);
			}
			return parsed;
		};
		const from = number("from") ?? 0, to = number("to");
		if (to !== undefined && to <= from) throw new Error("--to must be later than --from.");
		const thresholds: Partial<DraftThresholds> = {};
		for (const property of ["position", "scale", "rotation", "opacity"] as const) {
			const value = number(property);
			if (value !== undefined) thresholds[property] = value;
		}
		const options: Partial<PictureOptions> = {};
		for (const [flag, key] of [["picture-limit", "limit"], ["picture-distance", "distance"],
			["freeze-seconds", "freezeSeconds"], ["outlier-distance", "outlierDistance"]] as const) {
			const value = number(flag);
			if (value === undefined) continue;
			if (values.pictures !== true) throw new Error(`--${flag} requires --pictures.`);
			if (key === "limit" && (!Number.isInteger(value) || value > 300)) throw new Error("Set --picture-limit to an integer from 1 to 300.");
			if ((key === "distance" || key === "outlierDistance") && value > 1) throw new Error(`Set --${flag} to a value at most 1.`);
			options[key] = value;
		}
		const pictures = values.pictures === true ? options : undefined;
		return { command: "draft-check" as const, projectId, from, to, thresholds, json: values.json === true, all: values.all === true, timeoutMs, pictures };
	}
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
	if (command === "assemble") {
		const number = (flag: "gap" | "start") => {
			const value = values[flag];
			if (value === undefined) return undefined;
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 86400) throw new Error(`Set --${flag} to seconds from 0.`);
			return parsed;
		};
		if (typeof values.script !== "string") {
			throw new Error("Use assemble --script FILE [--plan FILE] [--voices FOLDER] [--gap S] [--start S] [--caption-preset NAME] [--name NAME] [--submit --project-id ID].");
		}
		if (values.submit === true && !projectId) throw new Error("Pass --project-id with --submit.");
		return { command: "assemble" as const, timeoutMs, input: {
			script: values.script, gap: number("gap"), start: number("start"),
			...(typeof values.plan === "string" && { plan: values.plan }), ...(typeof values.voices === "string" && { voices: values.voices }),
			...(typeof values["caption-preset"] === "string" && { captionPreset: values["caption-preset"] }), ...(typeof values.name === "string" && { name: values.name }),
			...(values.submit === true && projectId && { submit: { origin: url.origin, projectId } }),
		} };
	}
	if (command === "silence-plan" && !projectId) {
		throw new Error("Use silence-plan --project-id ID [--min-gap SECONDS] [--pad SECONDS] [--keep-fillers] [--keep-lead] [--tail] [--ignore-media NAME,...].");
	}
	const silence = command === "silence-plan" ? {
		...(typeof values["min-gap"] === "string" && { minGap: values["min-gap"] }),
		...(typeof values.pad === "string" && { pad: values.pad }),
		...(values["keep-fillers"] === true && { fillers: "0" }),
		...(values["keep-lead"] === true && { lead: "0" }),
		...(values.tail === true && { tail: "1" }),
		...(typeof values["ignore-media"] === "string" && { ignore: values["ignore-media"] }),
	} : undefined;
	const narration = command === "narration-plan" ? { clip: values.clip, newMedia: values["new-media"],
		json: values.json === true, from: values.from, to: values.to, all: values.all === true } : undefined;
	if (narration && (!projectId || typeof narration.clip !== "string" || !/^[\w-]{1,128}$/.test(narration.clip) ||
		typeof narration.newMedia !== "string" || !/^[\w-]{1,128}$/.test(narration.newMedia))) {
		throw new Error("Use narration-plan --project-id ID --clip CLIP_ID --new-media MEDIA_ID [--json].");
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
		const parsed = parseExportRequest({ rev: "cli", name: values.name, format: values.format, quality: values.quality, fps: values.fps === undefined ? undefined : Number(values.fps), allowMissing,
			size: values.size === undefined ? undefined : Number(values.size), preview: values.preview === true ? true : undefined });
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
	return { command: command as Exclude<Command, "transcript" | "review" | "draft-check" | "voice">, projectId, timeoutMs, origin: url.origin,
		...(media !== undefined && { media }), ...(request && { request }), ...(narration && { narration }), ...(silence && { silence }) };
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
	const help = helpText(args);
	if (help) return help;
	const options = parseArgs(args, minRenderSeconds);
	if (options.command === "transcript") return transcriptCommand(options.request, options.timeoutMs);
	if (options.command === "draft-check") {
		const { draftCheckCommand } = await import("./agent-draft-check");
		return draftCheckCommand(options);
	}
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
	if (options.command === "assemble") {
		const webDir = path.resolve(import.meta.dir, "..");
		loadEnvLocal(path.join(webDir, ".env.local"));
		const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
		const { assembleCommand } = await import("../src/agent/assemble-command");
		return await assembleCommand(options.input as import("../src/agent/assemble-command").AssembleInput, path.resolve(process.env.AGENT_FILES_ROOT ?? workspace), workspace,
			AbortSignal.timeout(options.timeoutMs));
	}
	if (options.command === "voice") {
		const webDir = path.resolve(import.meta.dir, "..");
		loadEnvLocal(path.join(webDir, ".env.local"));
		const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(webDir, "..", "..", "workspace"));
		const interrupt = new AbortController();
		const deadline = AbortSignal.timeout(options.timeoutMs);
		const stop = () => interrupt.abort(new Error("Interrupted by Ctrl+C."));
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			const { voiceCommand } = await import("../src/agent/voice");
			return await voiceCommand(options.input, path.resolve(process.env.AGENT_FILES_ROOT ?? workspace),
				AbortSignal.any([interrupt.signal, deadline]));
		} catch (error) {
			if (deadline.aborted) throw new Error("Timed out while making the voice. Increase --timeout and retry; the previous file is unchanged.");
			if (interrupt.signal.aborted) throw new Error("Interrupted while making the voice; the previous file is unchanged.");
			throw error;
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
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
	for (const [key, value] of Object.entries(options.silence ?? {})) target.searchParams.set(key, value);
	if (options.narration) {
		target.searchParams.set("clip", String(options.narration.clip));
		target.searchParams.set("newMedia", String(options.narration.newMedia));
		target.searchParams.set("format", options.narration.json ? "json" : "text");
		target.searchParams.set("timeoutMs", String(timeoutMs));
		if (options.narration.from !== undefined) target.searchParams.set("from", String(options.narration.from));
		if (options.narration.to !== undefined) target.searchParams.set("to", String(options.narration.to));
		if (options.narration.all) target.searchParams.set("all", "1");
	}
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
			const envFile = path.resolve(import.meta.dir, "../.env.local");
			return await runRender(response, { signal: interrupt.signal, timeoutMs,
				launch: (url, profile) => launchBrowser(url, profile, { envFile }) });
		}
		if (response.ok && (command === "transcript-view" || (options.narration && !options.narration.json))) return await response.text();
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

export { renderFailed };

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
