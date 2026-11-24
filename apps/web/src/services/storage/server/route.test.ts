import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET, PUT, POST, DELETE } from "../../../app/api/storage/[...slug]/route";
import { MediaThumbnailCache, storeMediaThumbnail } from "./media-thumbnails";
import { withProjectLock } from "./files";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-route-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});
const ctx = (id: string) => ({
	params: Promise.resolve({ slug: ["projects", id] }),
});
const request = (
	id: string,
	method: string,
	headers: Record<string, string> = {},
	body?: unknown,
) =>
	new Request(`http://127.0.0.1:3021/api/storage/projects/${id}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

describe("project adapter", () => {
	test("a late media write cannot restore a deleted project", async () => {
		const id = "deleted-with-media";
		expect((await PUT(request(id, "PUT", { "if-match": "new" }, { metadata: { id, name: id } }), ctx(id))).status).toBe(200);
		expect((await DELETE(request(id, "DELETE"), ctx(id))).status).toBe(200);
		const metadata = { id: "late", fileName: "late.png", fileType: "image/png" };
		const result = await PUT(
			request(`${id}/media/late`, "PUT", { "x-media-metadata": encodeURIComponent(JSON.stringify(metadata)) }, "png"),
			{ params: Promise.resolve({ slug: ["projects", id, "media", "late"] }) },
		);
		expect(result.status).toBe(404);
		expect(await fs.readdir(path.join(root, "projects"))).not.toContain(id);
	});

	test("detects stale revisions and migration does not restore deleted projects", async () => {
		const id = "test-project";
		const first = { metadata: { id, name: "awal" } };
		const created = await PUT(
			request(id, "PUT", { "if-match": "new" }, first),
			ctx(id),
		);
		expect(created.status).toBe(200);
		const old = created.headers.get("etag")!;
		const updated = await PUT(
			request(
				id,
				"PUT",
				{ "if-match": old },
				{ metadata: { id, name: "baru" } },
			),
			ctx(id),
		);
		expect(updated.status).toBe(200);
		expect(
			(await PUT(request(id, "PUT", { "if-match": old }, first), ctx(id)))
				.status,
		).toBe(409);
		expect((await GET(request(id, "GET"), ctx(id))).status).toBe(200);
		await DELETE(request(id, "DELETE"), ctx(id));
		const migration = await PUT(
			request(id, "PUT", { "x-migration": "1" }, first),
			ctx(id),
		);
		expect((await migration.json()).skipped).toBe(true);
		expect((await GET(request(id, "GET"), ctx(id))).status).toBe(404);
	});
	test("rejects foreign origins and traversal IDs", async () => {
		expect(
			(
				await GET(
					request("valid", "GET", { origin: "https://example.com" }),
					ctx("valid"),
				)
			).status,
		).toBe(403);
		expect((await GET(request("valid", "GET"), ctx("../escape"))).status).toBe(
			400,
		);
	});
});

describe("media thumbnails", () => {
	const inline = "data:image/jpeg;base64,/9j/2Q==";
	const bytes = [255, 216, 255, 217];

	async function legacyMedia(id: string) {
		const dir = path.join(root, "projects", id, "media");
		await fs.mkdir(path.join(dir, "_metadata"), { recursive: true });
		const metadata = { id: "m", name: "video", type: "video", fileType: "video/mp4", diskFile: "m.mp4", thumbnailUrl: inline };
		const metadataFile = path.join(dir, "_metadata", "m.json");
		await fs.writeFile(metadataFile, JSON.stringify(metadata));
		await fs.writeFile(path.join(dir, "m.mp4"), "original");
		return { dir, metadata, metadataFile };
	}

	async function call(url: string, method = "GET", headers?: Record<string, string>, body?: string) {
		const slug = url.slice("/api/storage/".length).split("/");
		const req = new Request(`http://127.0.0.1:3021${url}`, { method, headers, body });
		const handler = method === "DELETE" ? DELETE : method === "POST" ? POST : method === "PUT" ? PUT : GET;
		return handler(req, { params: Promise.resolve({ slug }) });
	}

	test("opens legacy media with a lightweight reference and migrates only the thumbnail requested", async () => {
		const id = "legacy";
		const { dir, metadata, metadataFile } = await legacyMedia(id);
		const list = await (await call(`/api/storage/projects/${id}/media`)).json();
		const url = list[0].thumbnailUrl;
		expect(url).toStartWith(`/api/storage/projects/${id}/media/m/thumbnail/`);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual(metadata);
		expect(await fs.readdir(dir)).not.toContain("_thumbnails");

		const response = await call(url);
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8")).thumbnailUrl).toBe(url);
		expect(await fs.readFile(path.join(dir, "m.mp4"), "utf8")).toBe("original");
		expect((await call(url, "GET", { "If-None-Match": response.headers.get("ETag")! })).status).toBe(304);
	});

	test("a replacement file changes the waveform revision even when its metadata and size match", async () => {
		const id = "file-revision";
		const { dir } = await legacyMedia(id);
		const url = `/api/storage/projects/${id}/media/m`;
		const before = await call(url);
		expect(await before.text()).toBe("original");
		const file = path.join(dir, "m.mp4");
		await fs.writeFile(file, "replaced");
		await fs.utimes(file, new Date(0), new Date(0));
		const after = await call(url);
		expect(await after.text()).toBe("replaced");
		expect(after.headers.get("X-Media-Revision")).toBeTruthy();
		expect(after.headers.get("X-Media-Revision")).not.toBe(before.headers.get("X-Media-Revision"));
	});

	test("reopens after the sidecar commits and the metadata update is interrupted", async () => {
		const id = "interrupted";
		const { metadata, metadataFile } = await legacyMedia(id);
		const url = await storeMediaThumbnail(id, "m", inline);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual(metadata);
		expect((await (await call(`/api/storage/projects/${id}/media`)).json())[0].thumbnailUrl).toBe(url);
		expect([...new Uint8Array(await (await call(url!)).arrayBuffer())]).toEqual(bytes);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8")).thumbnailUrl).toBe(url);
	});

	test("can display a legacy thumbnail while the project is writing", async () => {
		const id = "busy";
		const { metadata, metadataFile } = await legacyMedia(id);
		const [{ thumbnailUrl }] = await (await call(`/api/storage/projects/${id}/media`)).json();
		const write = Promise.withResolvers<void>();
		const held = withProjectLock(id, () => write.promise);
		try {
			const response = await call(thumbnailUrl);
			expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
			expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual(metadata);
		} finally {
			write.resolve();
			await held;
		}
		expect((await call(thumbnailUrl)).status).toBe(200);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8")).thumbnailUrl).toBe(thumbnailUrl);
	});

	test("preserves a legacy thumbnail for undo and copies it into the duplicate project", async () => {
		const { metadata } = await legacyMedia("source");
		await legacyMedia("duplicate");
		const base = "/api/storage/projects/source/media";
		const [{ thumbnailUrl }] = await (await call(base)).json();
		expect((await call(`${base}/m`, "DELETE")).status).toBe(200);
		expect(await (await call(base)).json()).toEqual([]);

		const restore = await call(`${base}/m`, "PUT", {
			"X-Media-Metadata": encodeURIComponent(JSON.stringify({ id: "m", fileName: "m.mp4", fileType: "video/mp4" })),
		}, "original");
		expect(restore.status).toBe(200);
		for (const project of ["source", "duplicate"]) {
			const media = `/api/storage/projects/${project}/media`;
			expect((await call(`${media}/m`, "POST", {}, JSON.stringify({ ...metadata, thumbnailUrl }))).status).toBe(200);
		}
		const [{ thumbnailUrl: duplicateUrl }] = await (await call("/api/storage/projects/duplicate/media")).json();
		expect(duplicateUrl).toStartWith("/api/storage/projects/duplicate/media/");
		expect((await call(base, "DELETE")).status).toBe(200);
		expect([...new Uint8Array(await (await call(duplicateUrl)).arrayBuffer())]).toEqual(bytes);
	});

	test("cache bounds bytes and entry count and evicts the least recently used", () => {
		const cache = new MediaThumbnailCache(5, 2);
		const thumb = (length: number) => ({ type: "image/jpeg", bytes: new Uint8Array(length) });
		cache.set("first", thumb(2));
		cache.set("second", thumb(2));
		expect(cache.get("first")).toBeDefined();
		cache.set("third", thumb(1));
		expect(cache.get("second")).toBeUndefined();
		cache.set("fourth", thumb(5));
		expect(cache.get("first")).toBeUndefined();
		expect(cache.get("third")).toBeUndefined();
		cache.set("oversize", thumb(6));
		expect(cache.get("oversize")).toBeUndefined();
		expect(cache.get("fourth")).toBeDefined();
	});
});
