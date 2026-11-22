import { JOB_HEADER, type JobTransport } from "./cli-transport";
import type { JobCommand } from "./cli-jobs";

export type ClaimedJob = { id: string; command: JobCommand; projectId: string };
export const editorTab = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const base = "/api/agent/cli";
const headers = { "Content-Type": "application/json" };

export function connectEditor(projectId: string) {
	const params = new URLSearchParams({ projectId, tab: editorTab });
	const source = new EventSource(`${base}/presence?${params}`);
	const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
	source.addEventListener("registered", () => resolve(), { once: true });
	source.addEventListener("error", () => {
		// A connected editor automatically registers again after the local server restarts.
		if (source.readyState === EventSource.CLOSED) reject(new Error("Could not register the editor. Reload this project."));
	});
	return { ready, close: () => { source.close(); resolve(); } };
}

export async function claimHiddenJob(id: string): Promise<ClaimedJob | null> {
	const response = await fetch(`${base}/claim/${id}`, { method: "POST", headers: { [JOB_HEADER]: id } });
	return response.ok ? response.json() : null;
}

export async function runClaimedJob(job: ClaimedJob, hidden: boolean, run: (transport: JobTransport) => Promise<void>) {
	const owner = hidden ? job.id : editorTab;
	const identity = { ...headers, [JOB_HEADER]: owner };
	const controller = new AbortController();
	const { signal } = controller;
	const post = (action: string, body: unknown) => fetch(`${base}/${action}/${job.id}`, {
		method: "POST", headers: identity, body: JSON.stringify(body), signal,
	});
	let finished = false;
	void fetch(`${base}/watch/${job.id}`, { headers: identity, signal })
		.then(() => controller.abort(), () => controller.abort());
	try {
		await run({
			signal,
			async progress(stage) {
				const response = await post("progress", { stage });
				if (!response.ok) controller.abort();
			},
			async request(input, init) {
				const target = String(input).replace("/api/agent/", `/api/agent/job/${job.id}/`);
				const requestHeaders = new Headers(init?.headers);
				requestHeaders.set(JOB_HEADER, owner);
				const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
				const response = await fetch(target, { ...init, headers: requestHeaders, signal: requestSignal });
				const action = target.split("/").pop()?.split("?")[0];
				if (response.ok && init?.method === "POST") {
					if (action === "applied" || action === "export-file" || action === "frames-result" || action === "changes-result") finished = true;
					if (action === "export-result" && typeof init.body === "string" && JSON.parse(init.body).status === "error") finished = true;
				}
				return response;
			},
		});
		if (!finished && !signal.aborted) throw new Error("The editor could not finish the job. Check that the project is ready and retry.");
	} catch (error) {
		if (signal.aborted) return;
		const message = error instanceof Error ? error.message : String(error);
		await post("fail", { error: message }).catch(() => {});
	} finally {
		controller.abort();
	}
}
