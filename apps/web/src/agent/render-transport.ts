const endpoint = "/api/agent/cli/render";
const tab = globalThis.crypto.randomUUID();
const tokenHeader = "x-bopencut-render-token";
export type RenderFetch = (...args: Parameters<typeof fetch>) => Promise<Response>;
export const renderTabHeaders = (projectId: string) => ({ "x-bopencut-render-tab": tab, "x-bopencut-project": projectId });

export function renderTransport(response: Response) {
	const token = response.headers.get(tokenHeader);
	if (!token) return { request: fetch, signal: undefined };
	const controller = new AbortController();
	void fetch(`${endpoint}?action=watch`, { headers: { [tokenHeader]: token } })
		.then(() => controller.abort(), () => controller.abort());
	const request: RenderFetch = (input, init) => {
		const [route, query] = String(input).split("?");
		const params = new URLSearchParams(query);
		params.set("action", route.split("/").at(-1)!);
		const headers = new Headers(init?.headers);
		headers.set(tokenHeader, token);
		return fetch(`${endpoint}?${params}`, { ...init, headers });
	};
	return { request, signal: controller.signal };
}

export async function readRenderRequest(kind: "export" | "frames", projectId: string, ready: boolean, signal?: AbortSignal) {
	// Headers keep the legacy request URL unchanged.
	return fetch(`/api/agent/${kind}-request`, {
		cache: "no-store", signal,
		headers: { ...renderTabHeaders(projectId), "x-bopencut-ready": ready ? "1" : "0" },
	});
}
