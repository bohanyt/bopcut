// Network policy for links the local server fetches on the user's or agent's behalf: links must resolve to
// public addresses, so a link (or a page that tricks the editor) cannot reach the machine or its local
// network. BOPENCUT_ALLOW_PRIVATE_URLS=1 lifts this for people who fetch from their own LAN.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CookieJar } from "tough-cookie";
import { isHttpUrl } from "./time";
import { RetrievalError } from "./server-errors";
import { Cancelled, checkCancelled } from "./jobs";

function ipv4Private(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return (
		a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function ipv6Private(ip: string): boolean {
	const v = ip.toLowerCase();
	if (v === "::" || v === "::1") return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
	if (mapped) return ipv4Private(mapped[1]);
	return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return ipv4Private(ip);
	if (kind === 6) return ipv6Private(ip);
	return true;
}

/** Throws unless every address the link's host resolves to is public (or private links are allowed). */
export async function assertPublicUrl(url: string, env: Record<string, string | undefined> = process.env, resolve = lookup, signal?: AbortSignal): Promise<void> {
	checkCancelled(signal, "URL lookup");
	if (env.BOPENCUT_ALLOW_PRIVATE_URLS === "1") return;
	let host: string;
	try {
		host = new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		throw new RetrievalError("not a valid link");
	}
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new RetrievalError("links to this machine or the local network are not fetched (set BOPENCUT_ALLOW_PRIVATE_URLS=1 to allow)");
	const addresses = await (async () => {
		if (isIP(host)) return [{ address: host }];
		const pending = resolve(host, { all: true });
		if (!signal) return pending;
		let abort!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(new Cancelled("URL lookup"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		try {
			return await Promise.race([pending, cancelled]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	})().catch((error: unknown) => {
		if (error instanceof Cancelled) throw error;
		throw new RetrievalError("the link's host could not be resolved: " + host);
	});
	if (addresses.some((a) => isPrivateAddress(a.address))) {
		throw new RetrievalError("links to this machine or the local network are not fetched (set BOPENCUT_ALLOW_PRIVATE_URLS=1 to allow)");
	}
}

/**
 * fetch that follows at most `maxRedirects` redirects itself, checking every hop with assertPublicUrl,
 * with a timeout. Use readCapped on the response to bound its size.
 */
export async function fetchPublic(url: string, init: RequestInit & { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; maxRedirects?: number; cookieJar?: CookieJar } = {}): Promise<Response> {
	const { fetchImpl = fetch, env, timeoutMs = 30_000, maxRedirects = 5, signal, cookieJar, ...rest } = init;
	const timeout = AbortSignal.timeout(timeoutMs);
	const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
	let current = url;
	const headers = new Headers(rest.headers);
	for (let hop = 0; hop <= maxRedirects; hop++) {
		checkCancelled(signal ?? undefined, "HTTP request");
		if (!isHttpUrl(current)) throw new RetrievalError("url must be an http(s) link");
		await assertPublicUrl(current, env, undefined, deadline);
		const hopHeaders = new Headers(headers);
		const cookie = cookieJar?.getCookieStringSync(current);
		if (cookie) hopHeaders.set("cookie", cookie);
		const res = await fetchImpl(current, { ...rest, headers: hopHeaders, redirect: "manual", signal: deadline, cache: "no-store" });
		if (cookieJar) {
			for (const value of res.headers.getSetCookie()) cookieJar.setCookieSync(value, current, { ignoreError: true });
		}
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			await res.body?.cancel().catch(() => {});
			const next = new URL(res.headers.get("location") as string, current);
			headers.delete("cookie");
			if (next.origin !== new URL(current).origin) headers.delete("authorization");
			current = next.href;
			continue;
		}
		return res;
	}
	throw new RetrievalError("too many redirects");
}

/** The response body, refusing more than `max` bytes while it streams in. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared > max) {
		await res.body?.cancel().catch(() => {});
		throw new RetrievalError(`the file is larger than ${Math.round(max / 1024 / 1024)} MB`);
	}
	if (!res.body) return Buffer.from(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new RetrievalError(`the file is larger than ${Math.round(max / 1024 / 1024)} MB`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}
