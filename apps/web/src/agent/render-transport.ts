const endpoint = "/api/agent/cli/render";
const tab = globalThis.crypto.randomUUID();
const tokenHeader = "x-bopencut-render-token";
export type RenderFetch = (...args: Parameters<typeof fetch>) => Promise<Response>;
export const renderTabHeaders = (projectId: string) => ({ "x-bopencut-render-tab": tab, "x-bopencut-project": projectId });

export function renderTransport(response: Response) {
	const token = response.headers.get(tokenHeader);
	if (!token) return { request: fetch, signal: undefined, release: undefined, reportStage: undefined };
	const controller = new AbortController();
	const hidden = response.headers.has("x-bopencut-render-kind");
	const release = () => controller.abort();
	let stageSequence = 0;
	let pendingStage: AbortController | undefined;
	void fetch(`${endpoint}?action=watch`, { headers: { [tokenHeader]: token }, signal: controller.signal })
		.then(() => controller.abort(), () => controller.abort());
	const request: RenderFetch = async (input, init) => {
		const [route, query] = String(input).split("?");
		const params = new URLSearchParams(query);
		const action = route.split("/").at(-1)!;
		params.set("action", action);
		const headers = new Headers(init?.headers);
		headers.set(tokenHeader, token);
		if (["stage", "export-result", "export-file", "frame"].includes(action)) {
			headers.set("x-bopencut-render-stage-sequence", String(++stageSequence));
		}
		const url = `${endpoint}?${params}`;
		const terminal = action === "frames-result" || (hidden && (action === "failure" ||
			(action === "export-result" && typeof init?.body === "string" && JSON.parse(init.body).status === "error")));
		if (!terminal) return fetch(url, { ...init, headers });
		for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt++) {
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
			try {
				const reply = await fetch(url, { ...init, headers, signal });
				if (reply.status < 500) return reply;
				await reply.body?.cancel();
			} catch {
				// Retry the same terminal JSON while the lease is alive.
			}
		}
		release();
		return new Response(null, { status: 409 });
	};
	const reportStage = (stage: string) => {
		// Keep delayed acknowledgments from occupying the connections used for uploads.
		pendingStage?.abort();
		pendingStage = new AbortController();
		void request("/api/agent/stage", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }),
			signal: AbortSignal.any([controller.signal, pendingStage.signal, AbortSignal.timeout(10_000)]),
		}).catch(() => { /* Progress reports must not hold up rendering. */ });
	};
	return { request, signal: controller.signal, release, reportStage };
}

export type RenderTransport = ReturnType<typeof renderTransport>;

export async function readRenderRequest(kind: "export" | "frames", projectId: string, ready: boolean, signal?: AbortSignal) {
	// Headers keep the legacy request URL unchanged.
	return fetch(`/api/agent/${kind}-request`, {
		cache: "no-store", signal,
		headers: { ...renderTabHeaders(projectId), "x-bopencut-ready": ready ? "1" : "0" },
	});
}
