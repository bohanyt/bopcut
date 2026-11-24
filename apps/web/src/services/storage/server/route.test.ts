import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET, PUT, POST, DELETE } from "../../../app/api/storage/[...slug]/route";
import { MediaThumbnailCache, mediaThumbnailReference } from "./media-thumbnails";
import { atomicWrite, repairedThumbnailFile, withProjectLock } from "./files";

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
		expect((await PUT(request(id, "PUT", { "if-match": "new" }, first), ctx(id))).status).toBe(404);
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

	async function call(url: string, method = "GET", headers?: Record<string, string>, body?: string, signal?: AbortSignal) {
		const req = new Request(`http://127.0.0.1:3021${url}`, { method, headers, body, signal });
		const slug = new URL(req.url).pathname.slice("/api/storage/".length).split("/");
		const handler = method === "DELETE" ? DELETE : method === "POST" ? POST : method === "PUT" ? PUT : GET;
		return handler(req, { params: Promise.resolve({ slug }) });
	}

	test("writes one matching missing thumbnail and leaves media and project bytes alone", async () => {
		const id = "missing-thumbnail";
		const { dir, metadata, metadataFile } = await legacyMedia(id);
		const { thumbnailUrl: _thumbnail, ...withoutThumbnail } = metadata;
		const metadataBytes = JSON.stringify({ ...withoutThumbnail, futureField: 42 });
		await fs.writeFile(metadataFile, metadataBytes);
		const projectFile = path.join(dir, "..", "project.json");
		const project = JSON.stringify({ metadata: { id, name: id } });
		await fs.writeFile(projectFile, project);
		const source = `/api/storage/projects/${id}/media/m`;
		const response = await call(source);
		const revision = response.headers.get("X-Media-Revision")!;
		expect(await response.text()).toBe("original");
		expect((await call(`${source}/thumbnail`, "POST", { "X-Media-Revision": "stale" }, inline)).status).toBe(409);
		const save = (data: string) => call(`${source}/thumbnail`, "POST", { "X-Media-Revision": revision }, data);
		const alternate = "data:image/jpeg,%FF%D8%FF%D9%80";
		const results = await Promise.all([save(inline), save(alternate)]);
		const [winner, other] = await Promise.all(results.map((result) => result.json()));
		expect(winner).toEqual(other);
		const sidecar = repairedThumbnailFile(id, "m");
		const stored = await fs.readFile(sidecar, "utf8");
		const saved = JSON.parse(stored);
		expect(saved.revision).toBe(revision);
		expect([inline, alternate]).toContain(saved.thumbnail);
		const expectedBytes = saved.thumbnail === inline ? bytes : [...bytes, 128];
		expect(await (await call(winner.url)).arrayBuffer()).toEqual(Uint8Array.from(expectedBytes).buffer);
		const [{ thumbnailUrl }] = await (await call(`/api/storage/projects/${id}/media`)).json();
		expect(thumbnailUrl).toBe(winner.url);
		const before = await fs.stat(sidecar);
		await save(inline);
		const after = await fs.stat(sidecar);
		expect(after).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
		expect(await fs.readFile(metadataFile, "utf8")).toBe(metadataBytes);
		expect(await fs.readFile(projectFile, "utf8")).toBe(project);
		expect(await fs.readFile(path.join(dir, "m.mp4"), "utf8")).toBe("original");
		await fs.writeFile(path.join(dir, "m.mp4"), "external replacement");
		expect((await call(winner.url)).status).toBe(404);
		expect((await (await call(`/api/storage/projects/${id}/media`)).json())[0].thumbnailUrl).toBeUndefined();
		await fs.rm(path.join(dir, "m.mp4"));
		expect((await call(source, "PUT", { "X-Media-Metadata": encodeURIComponent(JSON.stringify({
			id: "m", fileName: "m.mp4", fileType: "video/mp4",
		})) }, "uploaded replacement")).ok).toBe(true);
		expect(await fs.stat(sidecar).catch(() => null)).toBeNull();
		const nextMedia = await call(source);
		const nextRevision = nextMedia.headers.get("X-Media-Revision")!;
		await nextMedia.text();
		expect((await call(`${source}/thumbnail`, "POST", { "X-Media-Revision": nextRevision }, inline)).ok).toBe(true);
		expect((await call(source, "DELETE")).ok).toBe(true);
		expect(await fs.stat(sidecar).catch(() => null)).toBeNull();
	});

	test("an aborted repair waiting for the project lock never writes", async () => {
		const id = "aborted-thumbnail";
		const { metadata, metadataFile } = await legacyMedia(id);
		const { thumbnailUrl: _thumbnail, ...rest } = metadata;
		await fs.writeFile(metadataFile, JSON.stringify(rest));
		const source = `/api/storage/projects/${id}/media/m`;
		const file = await call(source);
		const revision = file.headers.get("X-Media-Revision")!;
		await file.text();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lock = withProjectLock(id, async () => { entered.resolve(); await release.promise; });
		await entered.promise;
		const controller = new AbortController();
		const pending = call(`${source}/thumbnail`, "POST", { "X-Media-Revision": revision }, inline, controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		release.resolve();
		await lock;
		expect((await pending).status).toBe(499);
		expect(await fs.stat(repairedThumbnailFile(id, "m")).catch(() => null)).toBeNull();
	});

	test.each(["junction", "hard link"])("ignores repaired thumbnails behind a %s", async (kind) => {
		const id = kind === "junction" ? "thumbnail-junction" : "thumbnail-hard-link";
		const { metadata, metadataFile } = await legacyMedia(id);
		const { thumbnailUrl: _thumbnail, ...rest } = metadata;
		await fs.writeFile(metadataFile, JSON.stringify(rest));
		const source = `/api/storage/projects/${id}/media/m`;
		const media = await call(source);
		const revision = media.headers.get("X-Media-Revision")!;
		await media.text();
		const sidecar = repairedThumbnailFile(id, "m");
		const outside = await fs.mkdtemp(path.join(root, "outside-thumbnails-"));
		const target = path.join(outside, "m.json");
		const data = JSON.stringify({ revision, thumbnail: inline });
		await fs.writeFile(target, data);
		if (kind === "junction") await fs.symlink(outside, path.dirname(sidecar), "junction");
		else {
			await fs.mkdir(path.dirname(sidecar));
			await fs.link(target, sidecar);
		}
		try {
			expect((await (await call(`/api/storage/projects/${id}/media`)).json())[0].thumbnailUrl).toBeUndefined();
			const reference = mediaThumbnailReference(id, "m", inline)!;
			expect((await call(reference)).status).toBe(404);
			expect((await call(`${source}/thumbnail`, "POST", { "X-Media-Revision": revision }, inline)).status).toBe(409);
			expect((await call(source, "DELETE")).ok).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe(data);
			expect(await fs.readFile(sidecar, "utf8")).toBe(data);
		} finally {
			if (kind === "junction") await fs.unlink(path.dirname(sidecar));
		}
	});

	test("sidecar cleanup errors do not prevent media replacement or removal", async () => {
		const id = "thumbnail-cleanup-error";
		const { dir } = await legacyMedia(id);
		const sidecar = repairedThumbnailFile(id, "m");
		await fs.mkdir(path.dirname(sidecar));
		await fs.writeFile(sidecar, "{}");
		await fs.rm(path.join(dir, "m.mp4"));
		const originalRemove = fs.rm.bind(fs);
		const remove = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (file === sidecar) throw new Error("sidecar locked");
			return originalRemove(file, options);
		});
		const log = spyOn(console, "warn").mockImplementation(() => {});
		const source = `/api/storage/projects/${id}/media/m`;
		try {
			expect((await call(source, "PUT", { "X-Media-Metadata": encodeURIComponent(JSON.stringify({
				id: "m", fileName: "m.mp4", fileType: "video/mp4",
			})) }, "replacement")).ok).toBe(true);
			expect(await (await call(source)).text()).toBe("replacement");
			expect((await call(source, "DELETE")).ok).toBe(true);
			expect((await call(source)).status).toBe(404);
			expect(await fs.readFile(sidecar, "utf8")).toBe("{}");
			expect(log).toHaveBeenCalledTimes(2);
		} finally {
			remove.mockRestore();
			log.mockRestore();
		}
	});

	test("projects legacy thumbnails into compact references without changing any files", async () => {
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
		expect(await fs.readFile(metadataFile, "utf8")).toBe(JSON.stringify(metadata));
		expect(await fs.readdir(dir)).not.toContain("_thumbnails");
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

	test("read-only thumbnail retrieval neither waits for a lock nor overwrites an external metadata edit", async () => {
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
		const updated = { ...metadata, thumbnailUrl: "data:image/jpeg,%FF%D8%FF%D9%80", words: [{ text: "new" }] };
		await atomicWrite(metadataFile, JSON.stringify(updated));
		expect((await call(thumbnailUrl)).status).toBe(404);
		const [current] = await (await call(`/api/storage/projects/${id}/media`)).json();
		const response = await call(current.thumbnailUrl);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes, 128]);
		const currentUrl = `/api/storage/projects/${id}/media/m/thumbnail`;
		expect((await call(currentUrl)).status).toBe(404);
		expect(await (await call(currentUrl, "GET", { Accept: "text/plain" })).text()).toBe(updated.thumbnailUrl);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual(updated);
	});

	test("metadata writes preserve the current inline thumbnail and unknown fields when given a stale reference", async () => {
		const { metadata, metadataFile } = await legacyMedia("merge");
		const base = "/api/storage/projects/merge/media";
		const [entry] = await (await call(base)).json();
		const changed = "data:image/jpeg,%FF%D8";
		await atomicWrite(metadataFile, JSON.stringify({ ...metadata, thumbnailUrl: changed, futureField: "keep", words: ["before"], staged: true }));
		expect((await call(`${base}/m`, "POST", {}, JSON.stringify({ ...entry, futureField: "stale", invented: true }))).status).toBe(200);
		const next = JSON.parse(await fs.readFile(metadataFile, "utf8"));
		expect(next).toEqual({ ...metadata, thumbnailUrl: changed, futureField: "keep" });
		expect((await call(`${base}/m`, "POST", {}, JSON.stringify({ ...entry, thumbnailUrl: inline }))).status).toBe(200);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual({ ...next, thumbnailUrl: inline });
	});

	test("metadata POST reads disk after the body and preserves a newer malformed thumbnail until explicit clear", async () => {
		const id = "pending-body";
		const base = `/api/storage/projects/${id}/media/m`;
		const { metadata, metadataFile } = await legacyMedia(id);
		const { thumbnailUrl: _thumbnail, ...fields } = metadata;
		const reading = Promise.withResolvers<void>();
		const parsed = Promise.withResolvers<void>();
		const req = new Request(`http://127.0.0.1:3021${base}`, { method: "POST" });
		req.json = async () => {
			reading.resolve();
			await parsed.promise;
			return { ...fields, name: "renamed", futureField: "stale" };
		};
		const posting = POST(req, { params: Promise.resolve({ slug: ["projects", id, "media", "m"] }) });
		await reading.promise;
		const malformed = { unexpected: "thumbnail value" };
		try {
			await atomicWrite(metadataFile, JSON.stringify({ ...metadata, thumbnailUrl: malformed, futureField: "current" }));
		} finally {
			parsed.resolve();
		}
		expect((await posting).status).toBe(200);
		const current = { ...fields, thumbnailUrl: malformed, futureField: "current", name: "renamed" };
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual(current);
		expect((await call(base, "POST", {}, JSON.stringify({ ...fields, thumbnailUrl: "data:image/jpeg;base64,!!" }))).status).toBe(200);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8")).thumbnailUrl).toEqual(malformed);
		expect((await call(base, "POST", {}, JSON.stringify({ ...fields, thumbnailUrl: null }))).status).toBe(200);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8"))).toEqual({ ...fields, futureField: "current" });
	});

	test.each([false, true])("a filesystem copy survives removal of the original (hard links: %s)", async (linked) => {
		const from = linked ? "linked-original" : "copied-original";
		const to = linked ? "linked" : "copied";
		const { dir } = await legacyMedia(from);
		const copy = path.join(root, "projects", to, "media");
		await fs.mkdir(path.join(copy, "_metadata"), { recursive: true });
		const transfer = linked ? fs.link : fs.copyFile;
		for (const file of ["m.mp4", "_metadata/m.json"]) await transfer(path.join(dir, file), path.join(copy, file));
		await call(`/api/storage/projects/${from}/media/m`, "DELETE");
		const [{ thumbnailUrl }] = await (await call(`/api/storage/projects/${to}/media`)).json();
		expect(thumbnailUrl).toStartWith(`/api/storage/projects/${to}/media/`);
		expect([...new Uint8Array(await (await call(thumbnailUrl)).arrayBuffer())]).toEqual(bytes);
	});

	test.each([false, true])("broken thumbnails return 404 and never prevent deletion (staged: %s)", async (staged) => {
		const { dir, metadata, metadataFile } = await legacyMedia("broken");
		const base = "/api/storage/projects/broken/media";
		for (const thumbnailUrl of ["data:image/jpeg;base64,!!", "data:image/jpeg,%xy"]) {
			await atomicWrite(metadataFile, JSON.stringify({ ...metadata, thumbnailUrl, staged }));
			const [entry] = await (await call(base)).json();
			expect((await call(entry.thumbnailUrl)).status).toBe(404);
		}
		expect((await call(`${base}/m`, "DELETE")).status).toBe(200);
		expect((await fs.readdir(dir)).sort()).toEqual(["_metadata"]);
	});

	test("undo and duplication can read the exact original data URL without modifying it", async () => {
		const { metadataFile } = await legacyMedia("undo");
		const base = "/api/storage/projects/undo/media";
		const [{ thumbnailUrl }] = await (await call(base)).json();
		const response = await call(thumbnailUrl, "GET", { Accept: "text/plain" });
		expect(response.headers.get("Vary")).toBe("Accept");
		expect(await response.text()).toBe(inline);
		expect(JSON.parse(await fs.readFile(metadataFile, "utf8")).thumbnailUrl).toBe(inline);
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
