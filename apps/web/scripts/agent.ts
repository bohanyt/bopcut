import { readFile } from "node:fs/promises";
import { parseArgs as parse } from "node:util";
import { launchBrowser, type RunningBrowser } from "./agent-browser";
import type { JobBody, JobCommand, JobUpdate } from "../src/agent/cli-jobs";
import { parseExportRequest } from "../src/agent/export";

type Command = JobCommand | "status" | "selection" | "notes" | "prefs";
const usage = "Use: bun run agent <status|selection|draft|frames|notes|changes|prefs|export> [--project-id ID] [--timeout SECONDS]";
const shared = { "project-id": { type: "string" }, timeout: { type: "string" }, url: { type: "string" } } as const;

export function parseArgs(args: string[]) {
	const [command, ...rest] = args;
	if (!["status", "selection", "draft", "frames", "notes", "changes", "prefs", "export"].includes(command)) throw new Error(usage);
	const { values, positionals } = parse({
		args: rest, allowPositionals: true,
		options: {
			...shared,
			...(command === "export" ? {
				format: { type: "string" }, quality: { type: "string" }, fps: { type: "string" }, name: { type: "string" },
				"no-audio": { type: "boolean" }, "allow-missing": { type: "boolean" },
			} as const : {}),
			...(command === "changes" ? { since: { type: "string" }, draft: { type: "string" } } as const : {}),
		},
	});
	const takesFile = command === "draft" || command === "frames";
	if (takesFile && positionals.length !== 1) throw new Error(`${command} requires one JSON file. Pass its path after the command.`);
	if (!takesFile && positionals.length) throw new Error(`Unexpected argument for ${command}. ${usage}`);
	const seconds = Number(values.timeout ?? (command === "export" ? 900 : command === "draft" || command === "frames" ? 120 : 30));
	if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86400) throw new Error("Set --timeout to a positive number of seconds, up to 86400.");
	const projectId = values["project-id"];
	if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("Pass a valid project ID to --project-id.");
	const url = new URL(values.url ?? process.env.BOPENCUT_URL ?? "http://127.0.0.1:3000");
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Set --url to the local editor origin, for example http://127.0.0.1:3000.");
	}
	let request: JobBody = {};
	if (command === "export") {
		const parsed = parseExportRequest({
			rev: "cli", format: values.format, quality: values.quality, name: values.name,
			fps: values.fps !== undefined ? Number(values.fps) : undefined, includeAudio: !values["no-audio"], allowMissing: values["allow-missing"],
		});
		if (!parsed || typeof parsed === "string") throw new Error(`Check export options: ${parsed ?? usage}.`);
		const { rev: _rev, ...options } = parsed;
		request = options;
	}
	if (command === "changes") {
		if (Boolean(values.since) === Boolean(values.draft)) throw new Error("Pass either --since with a snapshot's syncedAt or --draft with a draft revision.");
		request = { since: values.since, draft: values.draft };
	}
	return { command: command as Command, projectId, request, file: positionals[0], timeoutMs: Math.round(seconds * 1000), origin: url.origin };
}

function oneLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

async function readInput(command: Command, file: string): Promise<JobBody> {
	let body: JobBody;
	try { body = JSON.parse(await readFile(file, "utf8")); }
	catch (error) { throw new Error(`Could not read ${command} JSON. Check the file path and JSON syntax. ${oneLine(error)}`); }
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`Provide a JSON object for ${command}.`);
	if (body.rev !== undefined && (typeof body.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.rev))) {
		throw new Error("Use letters, digits, underscores or dashes for the revision, or omit it.");
	}
	if (command === "draft" && (!Array.isArray(body.ops) || !body.ops.length || body.ops.some((op) => !op || typeof op.op !== "string"))) {
		throw new Error("Set draft ops to a non-empty list of operations.");
	}
	if (command === "frames" && (!Array.isArray(body.times) || !body.times.length ||
		body.times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0) ||
		(body.width !== undefined && (typeof body.width !== "number" || !Number.isInteger(body.width) || body.width < 1 || body.width > 4096)))) {
		throw new Error("Set times to a non-empty list of non-negative seconds and width to a whole number from 1 to 4096.");
	}
	return body;
}

type Submission = JobUpdate & { id: string; projectId: string; hidden: boolean; profile?: string };
export type JobConnection = {
	submit(signal: AbortSignal): Promise<Submission>;
	wait(id: string, version: number, signal: AbortSignal): Promise<JobUpdate>;
	cancel(id: string): Promise<void>;
};

export async function runJob(connection: JobConnection, options: {
	id?: string;
	timeoutMs: number;
	launch(submission: Submission): RunningBrowser;
	progress(update: JobUpdate): void;
	signal?: AbortSignal;
}): Promise<JobBody> {
	const deadline = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
	let job: Submission | undefined;
	let browser: RunningBrowser | undefined;
	let stage = "waiting for a tab";
	let interrupt: (() => void) | undefined;
	const stopped = new Promise<never>((_, reject) => {
		interrupt = () => reject(new Error(deadline.aborted
			? `Timed out while ${stage}. Check the project before retrying, or increase --timeout.`
			: `Cancelled while ${stage}. Check the project before retrying.`));
		signal.addEventListener("abort", interrupt, { once: true });
		if (signal.aborted) interrupt();
	});
	try {
		job = await Promise.race([connection.submit(signal), stopped]);
		let update: JobUpdate = job;
		stage = update.stage;
		options.progress(update);
		if (job.hidden) browser = options.launch(job);
		const exited = browser?.exited.then(() => { throw new Error(`The hidden browser exited while ${stage}. Open the project in the editor once and retry.`); });
		while (!update.done) {
			const waiting = connection.wait(job.id, update.version, signal);
			update = await Promise.race(exited ? [waiting, stopped, exited] : [waiting, stopped]);
			stage = update.stage;
			options.progress(update);
		}
		if (!update.result) throw new Error("The job result could not be read. Check the project before retrying.");
		return update.result;
	} finally {
		if (interrupt) signal.removeEventListener("abort", interrupt);
		try { await browser?.stop(); }
		finally {
			const id = options.id ?? job?.id;
			if (id) await connection.cancel(id);
		}
	}
}

async function main(args: string[], signal: AbortSignal) {
	const options = parseArgs(args);
	const base = options.origin + "/api/agent/cli";
	const project = options.projectId ? "?projectId=" + encodeURIComponent(options.projectId) : "";
	const call = async <T>(route: string, abort: AbortSignal, body?: unknown): Promise<T> => {
		let response: Response;
		try {
			response = await fetch(base + "/" + route, {
				signal: abort, redirect: "error",
				...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			});
		} catch {
			abort.throwIfAborted();
			throw new Error(`Cannot reach the editor at ${options.origin}. Start it from apps/web with bunx next dev --turbopack -H 127.0.0.1 -p ${new URL(options.origin).port || "80"}, then retry.`);
		}
		const result = await response.json().catch(() => null);
		if (!response.ok || !result) throw new Error(result?.error ?? "The server did not answer the agent CLI. Start this version of the editor and retry.");
		return result as T;
	};
	if (options.command === "status" || options.command === "notes" || options.command === "selection" || options.command === "prefs") {
		return call<JobBody>(options.command + project, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]));
	}
	const request = options.file ? await readInput(options.command, options.file) : options.request;
	const id = crypto.randomUUID();
	let lastProgress = "";
	return runJob({
		submit: (abort) => call("submit", abort, { id, command: options.command, projectId: options.projectId, request, timeoutMs: options.timeoutMs }),
		wait: (id, version, abort) => call(`wait/${id}?version=${version}`, abort),
		async cancel(id) {
			await call(`cancel/${id}`, AbortSignal.timeout(5000), {}).catch(() => {});
		},
	}, {
		id, timeoutMs: options.timeoutMs, signal,
		launch: ({ id, profile }) => {
			if (!profile) throw new Error("The server did not supply a browser profile. Restart the editor server and retry.");
			return launchBrowser(`${options.origin}/agent/job/${id}`, profile);
		},
		progress(update) {
			const message = update.stage + (update.percent === undefined ? "" : ` ${update.percent}%`);
			if (message !== lastProgress) console.error(message);
			lastProgress = message;
		},
	});
}

if (import.meta.main) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		const result = await main(process.argv.slice(2), controller.signal);
		const error = result.error ?? result.saveError;
		if (error || (Array.isArray(result.errors) && result.errors.length)) {
			const detail = oneLine(error ?? "Some frames could not be rendered");
			console.error(`${detail} Read the JSON result, correct the inputs, and retry.`);
			process.exitCode = 1;
		}
		console.log(JSON.stringify(result));
	} catch (error) {
		const message = oneLine(error);
		console.error(message);
		console.log(JSON.stringify({ error: message }));
		process.exitCode = controller.signal.aborted ? 130 : 1;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
