import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { checkCancelled } from "./jobs";
import { fetchPublic, readCapped } from "./net";
import { RetrievalError } from "./server-errors";
import { isHttpUrl } from "./time";

export type Stream = { url?: string; protocol?: string; http_headers?: Record<string, string>; cookies?: string };
type Network = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; signal: AbortSignal };
const chunkSize = 512 * 1024;
const seekError = () => new RetrievalError("the selected stream is not seekable over HTTP; use a seekable file or a local copy");

/** yt-dlp emits applicable cookies as pairs followed by their individual attributes. */
function scopedCookies(raw: string, source: URL) {
	type Cookie = { pair: string; domain?: string; path?: string; secure?: boolean; expires?: number };
	const cookies: Cookie[] = [];
	let cookie: Cookie | undefined;
	for (const part of raw.split(/;\s*/)) {
		const equals = part.indexOf("=");
		const key = (equals < 0 ? part : part.slice(0, equals)).toLowerCase();
		const value = part.slice(equals + 1);
		if (!part || key === "version") continue;
		if (key === "domain" && cookie) cookie.domain = value.toLowerCase();
		else if (key === "path" && cookie) cookie.path = value;
		else if (key === "expires" && cookie) cookie.expires = Number(value);
		else if (key === "secure" && cookie && equals < 0) cookie.secure = true;
		else if (equals >= 0) {
			cookie = { pair: part };
			cookies.push(cookie);
		}
	}
	return (target: URL) => cookies.filter(({ domain, path, secure, expires }) => {
		if (target.origin !== source.origin || (secure && target.protocol !== "https:")) return false;
		if (expires !== undefined && (!Number.isFinite(expires) || expires * 1000 <= Date.now())) return false;
		if (domain && target.hostname !== domain.replace(/^\./, "") && !target.hostname.endsWith("." + domain.replace(/^\./, ""))) return false;
		if (!path) return target.pathname === source.pathname;
		return target.pathname === path || target.pathname.startsWith(path.endsWith("/") ? path : path + "/");
	}).map(({ pair }) => pair).join("; ");
}

async function fetchRange(stream: Stream, start: number, end: number, network: Network) {
	const headers = new Headers(stream.http_headers);
	headers.set("Accept-Encoding", "identity");
	headers.set("Range", "bytes=" + start + "-" + end);
	const cookieForUrl = stream.cookies ? scopedCookies(stream.cookies, new URL(stream.url!)) : undefined;
	const res = await fetchPublic(stream.url!, { ...network, headers, cookieForUrl });
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
	const size = Number(match?.[3]);
	const valid = res.status === 206 && Number(match?.[1]) === start && Number(match?.[2]) === end &&
		Number.isSafeInteger(size) && end < size && /^(?:identity)?$/i.test(res.headers.get("content-encoding") ?? "");
	if (!valid) {
		await res.body?.cancel().catch(() => {});
		throw seekError();
	}
	return { size, body: res };
}

/** Expose only verified, bounded byte reads to the demuxer, including its speculative reads. */
export async function withSectionInputs<T>(
	streams: Stream[], duration: number | undefined, seconds: number, network: Network,
	work: (inputs: string[]) => Promise<T>,
): Promise<T> {
	const sources: {
		stream: Stream; size: number; remaining: number; chunk: number; recent: { start: number; bytes: Buffer }[];
	}[] = [];
	for (const stream of streams) {
		if (!isHttpUrl(stream.url) || !/^https?$/.test(stream.protocol ?? "")) throw seekError();
		const { size, body } = await fetchRange(stream, 0, 0, network).catch((error: unknown) => {
			checkCancelled(network.signal, "seekability check");
			if (error instanceof RetrievalError) throw error;
			throw new RetrievalError("could not check the stream for byte ranges; retry or use a local copy");
		});
		await body.body?.cancel();
		const bytesPerSecond = duration && duration > 0 ? size / duration : 16_384;
		// A small initial read lets the demuxer seek without fetching seconds of unused media.
		const chunk = Math.min(chunkSize, Math.max(4096, Math.ceil(bytesPerSecond * Math.min(seconds, 2))));
		const estimate = duration && duration > 0 ? bytesPerSecond * (seconds + 20) * 2 : (seconds + 20) * 2_000_000;
		const ceiling = duration ? (duration > seconds + 30 ? size - 2 : 2 * size) : (size > 4 * chunkSize ? size - 2 : 2 * size);
		sources.push({ stream, size, chunk, recent: [], remaining: Math.min(ceiling, Math.max(4 * chunkSize, Math.ceil(estimate))) });
	}
	checkCancelled(network.signal, "seekability check");
	let failure: unknown;
	const token = "/" + randomUUID() + "/";
	const active = new Set<Promise<void>>();
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((req, res) => {
		const index = req.url?.startsWith(token) ? req.url.slice(token.length) : "";
		const source = /^\d+$/.test(index) ? sources[Number(index)] : undefined;
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
		const start = Number(range?.[1] ?? 0), end = Number(range?.[2] || ((source?.size ?? 0) - 1));
		if (!source || req.method !== "GET" || start > end || end >= source.size) {
			res.writeHead(416).end();
			return;
		}
		const controller = new AbortController();
		res.once("close", () => controller.abort());
		const signal = AbortSignal.any([network.signal, controller.signal]);
		const transfer = (async () => {
			let bytes: Buffer;
			const cached = source.recent.find((block) => start >= block.start && start < block.start + block.bytes.length);
			if (cached) {
				bytes = cached.bytes.subarray(start - cached.start, end + 1 - cached.start);
			} else {
				const count = Math.min(source.chunk, end - start + 1, source.remaining);
				if (count <= 0) throw new RetrievalError("the section exceeded its transfer budget; use a shorter range or a local copy");
				source.remaining -= count;
				const { body, size } = await fetchRange(source.stream, start, start + count - 1, { ...network, signal });
				bytes = await readCapped(body, count);
				if (bytes.length !== count || size !== source.size) throw seekError();
				source.recent.unshift({ start, bytes });
				if (source.recent.length > 8) source.recent.pop();
			}
			res.writeHead(206, { "Accept-Ranges": "bytes", "Content-Length": bytes.length,
				"Content-Range": "bytes " + start + "-" + (start + bytes.length - 1) + "/" + source.size, Connection: "close" });
			res.end(bytes);
		})().catch((error) => {
			if (!signal.aborted) {
				failure ??= error instanceof RetrievalError ? error : new RetrievalError("the section transfer failed; retry or use a local copy");
				res.writeHead(502).end();
			}
		}).finally(() => active.delete(transfer));
		active.add(transfer);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new RetrievalError("could not open the section reader");
		const result = await work(sources.map((_, index) => "http://127.0.0.1:" + address.port + token + index));
		if (failure) throw failure;
		return result;
	} catch (error) {
		checkCancelled(network.signal, "section transfer");
		throw failure ?? error;
	} finally {
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		for (const socket of sockets) socket.destroy();
		await closed;
		await Promise.allSettled(active);
	}
}
