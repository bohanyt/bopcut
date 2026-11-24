import { isForeignOrigin } from "@/agent/origin";
import { clearProxies, openSession, pauseProxyJobs, proxyPath, updateSession } from "@/services/proxies/server";
import { safeId, streamMediaFile } from "@/services/storage/server/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ids(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 2000) throw new Error("Invalid asset list");
	return [...new Set(value.map((id: unknown) => typeof id === "string" ? safeId(id) : ""))].filter(Boolean);
}
export async function GET(request: Request) {
	if (isForeignOrigin(request)) return new Response(null, { status: 403 });
	const file = await proxyPath(new URL(request.url).searchParams.get("key") ?? "");
	return file ? streamMediaFile(file, "video/mp4", request.headers.get("range")) : new Response(null, { status: 404 });
}
export async function POST(request: Request) {
	if (isForeignOrigin(request)) return new Response(null, { status: 403 });
	try {
		const body = await request.json();
		const id = safeId(body.id ?? "");
		if (body.action === "update") {
			updateSession(id, { ...(body.ids === undefined ? {} : { ids: ids(body.ids) }), ...(typeof body.paused === "boolean" ? { paused: body.paused } : {}) },
				body.replaced === undefined ? [] : ids(body.replaced));
			return new Response(null, { status: 204 });
		}
		if (body.enabled === false && body.action !== "pause") return new Response(null, { status: 204 });
		const project = body.action === "pause" ? "" : safeId(body.project ?? "");
		const queue = body.action === "pause" ? [] : ids(body.ids);
		let close: (() => void) | undefined;
		let closed = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("\n"));
				close = body.action === "pause" ? pauseProxyJobs() : openSession(id, {
					project, ids: queue, paused: !!body.paused, software: body.software === true,
					send(update) { if (!closed && !request.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(update) + "\n")); },
				});
				request.signal.addEventListener("abort", () => {
					if (closed) return;
					closed = true;
					close?.();
					controller.close();
				}, { once: true });
			},
			cancel() { closed = true; close?.(); },
		});
		return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
	} catch { return new Response(null, { status: 400 }); }
}
export async function DELETE(request: Request) {
	if (isForeignOrigin(request)) return new Response(null, { status: 403 });
	if (!await clearProxies()) return new Response(null, { status: 409 });
	return new Response(null, { status: 204 });
}
