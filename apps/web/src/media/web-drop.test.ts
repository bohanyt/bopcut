import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchWebFile, handleRetrieve, sniffMedia } from "@/retrieval/server";
import { dataUrlToFile, fetchWebMedia, hasWebMedia, mediaGroupsFrom, mediaLinksFrom, pastedMediaLinks, percentDecodeBytes, unwrapImageLink } from "./web-drop";

const LAN = { BOPENCUT_ALLOW_PRIVATE_URLS: "1" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ascii = (text: string) => [...new TextEncoder().encode(text)];
const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...ascii("ftypavif"), 0, 0, 0, 0, ...ascii("avifmif1")]);

describe("links from a web drop", () => {
	test("only drags from other pages count (not files)", () => {
		expect(hasWebMedia(["text/uri-list", "text/html"])).toBe(true);
		expect(hasWebMedia(["Files"])).toBe(false);
		expect(hasWebMedia(["text/plain"])).toBe(false);
	});
	test("search result links resolve to the image behind them, ahead of the thumbnail", () => {
		const link = "https://www.google.com/imgres?imgurl=https%3A%2F%2Fexample.com%2Fcat.jpg&imgrefurl=https%3A%2F%2Fexample.com";
		expect(unwrapImageLink(link)).toBe("https://example.com/cat.jpg");
		const links = mediaLinksFrom({ uriList: link, html: '<a><img src="https://encrypted-tbn0.gstatic.com/images?q=x&amp;s=1"></a>' });
		expect(links).toEqual(["https://example.com/cat.jpg", "https://encrypted-tbn0.gstatic.com/images?q=x&s=1"]);
	});
	test("an image tag beats a page link; data URLs are kept; other schemes are dropped", () => {
		const links = mediaLinksFrom({ uriList: "# comment\nhttps://example.com/page", html: '<img alt="x" src="data:image/png;base64,iVBORw0KGgo=">' });
		expect(links).toEqual(["data:image/png;base64,iVBORw0KGgo=", "https://example.com/page"]);
		expect(mediaLinksFrom({ uriList: "javascript:alert(1)\nfile:///etc/passwd" })).toEqual([]);
	});
	test("a data URL becomes a file without the server", async () => {
		const { file } = await fetchWebMedia(["data:image/png;base64,iVBORw0KGgo="]);
		expect(file?.type).toBe("image/png");
		expect(file?.name).toBe("dropped image.png");
		expect(file?.size).toBe(8);
	});
});

describe("server fetch of a web file", () => {
	let root: string;
	let calls: number;
	const fake = (type: string, body: Uint8Array | string, status = 200) =>
		(async () => {
			calls++;
			return new Response(typeof body === "string" ? body : new Blob([body as BlobPart]), { status, headers: { "content-type": type } });
		}) as unknown as typeof fetch;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "web-"));
		calls = 0;
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("an image is saved once with its name, then served from the cache", async () => {
		const fetchImpl = fake("image/jpeg; charset=binary", JPEG);
		const first = await fetchWebFile("https://example.com/pics/Cute%20cat.jpg?x=1", { filesRoot: root, fetchImpl, env: LAN });
		expect(first).toMatchObject({ type: "image", mime: "image/jpeg", name: "Cute cat", cached: false });
		expect(first.path).toMatch(/^retrieved\/web\/[0-9a-f]{16}\.asset\/[0-9a-f]{16}\.jpg$/);
		const second = await fetchWebFile("https://example.com/pics/Cute%20cat.jpg?x=1", { filesRoot: root, fetchImpl, env: LAN });
		expect(second.cached).toBe(true);
		expect(calls).toBe(1);
	});

	test("pages, errors and bad links are refused", async () => {
		const page = await handleRetrieve({ kind: "file", url: "https://example.com/" }, { filesRoot: root, fetchImpl: fake("text/html", "<html>"), env: LAN });
		expect(page.status).toBe(502);
		expect(JSON.stringify(page.body)).toContain("not a supported image");
		const missing = await handleRetrieve({ kind: "file", url: "https://example.com/x.png" }, { filesRoot: root, fetchImpl: fake("image/png", "", 404), env: LAN });
		expect(missing.status).toBe(502);
		const bad = await handleRetrieve({ kind: "file", url: "ftp://example.com/x.png" }, { filesRoot: root, fetchImpl: fake("image/png", "x"), env: LAN });
		expect(bad.status).toBe(400);
	});

	test("the format comes from the bytes: a mislabeled PNG is kept, AVIF gets its type, SVG is refused", async () => {
		const png = await fetchWebFile("https://example.com/a", { filesRoot: root, fetchImpl: fake("application/octet-stream", PNG), env: LAN });
		expect(png).toMatchObject({ type: "image", mime: "image/png" });
		expect(png.path.endsWith(".png")).toBe(true);
		const avif = await fetchWebFile("https://example.com/b.avif", { filesRoot: root, fetchImpl: fake("image/avif", AVIF), env: LAN });
		expect(avif).toMatchObject({ type: "image", mime: "image/avif" });
		const svg = await handleRetrieve({ kind: "file", url: "https://example.com/c.svg" }, { filesRoot: root, fetchImpl: fake("image/svg+xml", '<?xml version="1.0"?><svg onload="alert(1)"></svg>'), env: LAN });
		expect(svg.status).toBe(502);
		expect(JSON.stringify(svg.body)).toContain("SVG");
		expect(sniffMedia(new Uint8Array([...ascii("OggS"), 0, 2]))).toMatchObject({ type: "audio", mime: "audio/ogg" });
		expect(sniffMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toMatchObject({ type: "video", ext: ".webm" });
		expect(sniffMedia(new Uint8Array(ascii("hello world")))).toBeNull();
	});

	test("links to this machine are refused, also behind a redirect", async () => {
		const direct = await handleRetrieve({ kind: "file", url: "http://127.0.0.1:3000/api/agent/bundle" }, { filesRoot: root, fetchImpl: fake("image/png", PNG), env: {} });
		expect(direct.status).toBe(502);
		expect(calls).toBe(0);
		const redirecting = (async (url: string) => {
			calls++;
			return url.startsWith("https://93.184.215.14")
				? new Response(null, { status: 302, headers: { location: "http://192.168.1.1/router.png" } })
				: new Response(new Blob([PNG]), { headers: { "content-type": "image/png" } });
		}) as unknown as typeof fetch;
		const hop = await handleRetrieve({ kind: "file", url: "https://93.184.215.14/img.png" }, { filesRoot: root, fetchImpl: redirecting, env: {} });
		expect(hop.status).toBe(502);
		expect(calls).toBe(1);
	});

	test("a body without a length is still capped while it streams", async () => {
		const chunk = 1024 * 1024;
		let sent = 0;
		const endless = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						const bytes = new Uint8Array(chunk);
						if (sent === 0) bytes.set(JPEG);
						sent += chunk;
						controller.enqueue(bytes);
					},
				}),
				{ headers: { "content-type": "image/jpeg" } },
			)) as unknown as typeof fetch;
		const res = await handleRetrieve({ kind: "file", url: "https://example.com/huge.jpg" }, { filesRoot: root, fetchImpl: endless, env: LAN });
		expect(res.status).toBe(502);
		expect(JSON.stringify(res.body)).toContain("larger than");
		expect(sent).toBeLessThan(110 * chunk);
	});

	test("two drops of the same link at once fetch it once", async () => {
		const fetchImpl = fake("image/png", PNG);
		const [a, b] = await Promise.all([
			fetchWebFile("https://example.com/same.png", { filesRoot: root, fetchImpl, env: LAN }),
			fetchWebFile("https://example.com/same.png", { filesRoot: root, fetchImpl, env: LAN }),
		]);
		expect(a.path).toBe(b.path);
		expect(calls).toBe(1);
		const name = path.basename(a.path);
		expect((await fs.readdir(path.dirname(path.join(root, a.path)))).sort()).toEqual([name.replace(".png", ".json"), name].sort());
	});
});

describe("drops and pastes, edge cases", () => {
	test("percent-encoded and malformed data URLs", () => {
		expect([...percentDecodeBytes("%89PNG%0D%0A")]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		expect(dataUrlToFile("data:image/png,%89PNG%0D%0A")?.size).toBe(6);
		expect(dataUrlToFile("data:image/png;base64,***not base64***")).toBeNull();
		expect(dataUrlToFile("data:image/png;charset=utf-8;base64,iVBORw0KGgo=")?.size).toBe(8);
	});

	test("a bad data URL does not stop the next candidate", async () => {
		const { file } = await fetchWebMedia(["data:image/png;base64,***", "data:image/png;base64,iVBORw0KGgo="]);
		expect(file?.size).toBe(8);
	});

	test("several images in one drop are separate items; one image keeps its fallbacks", () => {
		const html = '<p><img src="https://example.com/a.jpg"> text <img src="https://example.com/b.png"></p>';
		expect(mediaGroupsFrom({ html })).toEqual([["https://example.com/a.jpg"], ["https://example.com/b.png"]]);
		const search = "https://www.google.com/imgres?imgurl=https%3A%2F%2Fexample.com%2Fcat.jpg";
		expect(mediaGroupsFrom({ uriList: search, html: '<img src="https://t.example/thumb">' })).toEqual([["https://example.com/cat.jpg", "https://t.example/thumb"]]);
		expect(mediaGroupsFrom({ text: "just words here" })).toEqual([]);
	});

	test("a pasted search-result link is media even without a file extension", () => {
		const transfer = (text: string, html = "") => ({ getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : "") }) as unknown as DataTransfer;
		expect(pastedMediaLinks(transfer("https://www.google.com/imgres?imgurl=https%3A%2F%2Fexample.com%2Fimage%3Fid%3D4"))).toEqual(["https://example.com/image?id=4"]);
		expect(pastedMediaLinks(transfer("https://example.com/article"))).toEqual([]);
	});
});
