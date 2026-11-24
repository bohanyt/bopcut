import { expect, test } from "bun:test";
import { DELETE, GET, POST } from "./route";

test("all proxy methods require loopback Host even with a matching or missing Origin", async () => {
	for (const handler of [GET, POST, DELETE]) {
		for (const origin of [undefined, "http://other.example:3456"]) {
			const headers = new Headers({ Host: "other.example:3456" });
			if (origin) headers.set("Origin", origin);
			expect((await handler(new Request("http://localhost:3456/api/proxies", { headers }))).status).toBe(403);
		}
	}
});

test("cross-site and foreign browser requests are rejected on loopback", async () => {
	for (const handler of [GET, POST, DELETE]) {
		expect((await handler(new Request("http://localhost/api/proxies", {
			headers: { Host: "localhost", "Sec-Fetch-Site": "cross-site" },
		}))).status).toBe(403);
		expect((await handler(new Request("http://localhost/api/proxies", {
			headers: { Host: "127.0.0.1:3456", Origin: "http://localhost" },
		}))).status).toBe(403);
	}
	expect((await GET(new Request("http://localhost/api/proxies", {
		headers: { Host: "127.0.0.1:3456", Origin: "http://127.0.0.1:3456" },
	}))).status).toBe(404);
});
