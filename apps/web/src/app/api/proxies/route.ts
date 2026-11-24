import { clearProxies, openSession, proxyPath, updateSession } from "@/services/proxies/server";
import { safeId, streamMediaFile } from "@/services/storage/server/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowed(request: Request) {
	const url = new URL(request.url);
	const origin = request.headers.get("origin");
	return ["127.0.0.1", "localhost"].includes(url.hostname) && (!origin || origin === url.origin) &&
		request.headers.get("sec-fetch-site") !== "cross-site";
}
function ids(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 2000) throw new Error("Invalid asset list");
	return [...new Set(value.map((id: unknown) => typeof id === "string" ? safeId(id) : ""))].filter(Boolean);
}
export async function GET(request: Request) {
	if (!allowed(request)) return new Response(null, { status: 403 });
	const file = await proxyPath(new URL(request.url).searchParams.get("key") ?? "");
	return file ? streamMediaFile(file, "video/mp4", request.headers.get("range")) : new Response(null, { status: 404 });
}
export async function POST(request: Request) {
	if (!allowed(request)) return new Response(null, { status: 403 });
	try {
		const body = await request.json();
		const id = safeId(body.id ?? "");
		if (body.action === "update") {
			updateSession(id, { ...(body.ids === undefined ? {} : { ids: ids(body.ids) }), ...(typeof body.paused === "boolean" ? { paused: body.paused } : {}) });
			return new Response(null, { status: 204 });
		}
		const project = safeId(body.project ?? "");
		const queue = ids(body.ids);
		let close: (() => void) | undefined;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				close = openSession(id, { project, ids: queue, paused: !!body.paused, software: body.software === true, enabled: body.enabled,
					send(update) { if (!request.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(update) + "\n")); },
				});
				request.signal.addEventListener("abort", () => { close?.(); controller.close(); }, { once: true });
			},
			cancel() { close?.(); },
		});
		return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
	} catch { return new Response(null, { status: 400 }); }
}
export async function DELETE(request: Request) {
	if (!allowed(request)) return new Response(null, { status: 403 });
	await clearProxies();
	return new Response(null, { status: 204 });
}
