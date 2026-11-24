import { expect, test } from "bun:test";
import { VideoCache } from "./service";

test("a partial proxy response cannot block fallback or permanently fail its URL", async () => {
	const cache = new VideoCache();
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response(new ReadableStream({
				start(stream) { stream.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); },
			}), { status: 206, headers: { "Content-Range": "bytes 0-1023/1024" } });
		},
	});
	try {
		const start = performance.now();
		expect(await cache.getProxyFrameAt(server.url.href, 0, 1024)).toBeNull();
		expect(performance.now() - start).toBeLessThan(1600);
		expect(requests).toBe(1);
		expect(await cache.getProxyFrameAt(server.url.href, 0, 1024)).toBeNull();
		expect(requests).toBe(2);
	} finally {
		cache.clear();
		server.stop(true);
	}
});
