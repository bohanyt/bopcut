import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { spyOn } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
	atomicWrite,
	retryTransient,
	mediaResponse,
	projectDir,
	readJson,
	removeMedia,
	revision,
	safeId,
	saveMedia,
	streamMediaFile,
	withProjectLock,
} from "./files";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-test-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});

describe("folder storage", () => {
	test("rejects traversal and unsafe IDs", () => {
		for (const id of ["../lain", "..", "a/b", "a\\b", "C:foo", "", "a.b"])
			expect(() => safeId(id)).toThrow();
		expect(safeId("abc-123_ok")).toBe("abc-123_ok");
	});
	test("atomic writes and revision queue", async () => {
		const file = path.join(projectDir("project-1"), "project.json");
		await Promise.all(
			Array.from({ length: 10 }, (_, n) =>
				withProjectLock("project-1", async () => {
					const old = await readJson(file);
					await atomicWrite(
						file,
						JSON.stringify({ count: (old?.count ?? 0) + 1, n }),
					);
				}),
			),
		);
		const value = await readJson(file);
		expect(value.count).toBe(10);
		expect(revision(value)).toBe(revision(JSON.parse(JSON.stringify(value))));
		expect(
			(await fs.readdir(path.dirname(file))).some((name) =>
				name.endsWith(".tmp"),
			),
		).toBe(false);
	});
	test("writes media once and reads ranges", async () => {
		const meta = {
			id: "media-1",
			fileName: "contoh.mp4",
			fileType: "video/mp4",
		};
		await saveMedia(
			"project-1",
			meta.id,
			meta,
			new Blob(["0123456789"]).stream(),
		);
		await saveMedia(
			"project-1",
			meta.id,
			meta,
			new Blob(["overwritten"]).stream(),
		);
		const response = await mediaResponse("project-1", meta.id, "bytes=2-5");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await response.text()).toBe("2345");
		expect(
			(await mediaResponse("project-1", meta.id, "bytes=99-")).status,
		).toBe(416);
	});
	test("reads a range spanning a chunk boundary through the final byte", async () => {
		const chunk = 512 * 1024;
		const contents = Uint8Array.from({ length: 2 * chunk + 3 }, (_, i) => i % 251);
		const file = path.join(root, "chunk-boundaries.mp4");
		await fs.writeFile(file, contents);
		const response = await streamMediaFile(file, "video/mp4", `bytes=${chunk - 1}-`);
		expect(response.status).toBe(206);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("content-length")).toBe(String(chunk + 4));
		expect(response.headers.get("content-range")).toBe(`bytes ${chunk - 1}-${contents.length - 1}/${contents.length}`);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(contents.slice(chunk - 1));
		const invalid = await streamMediaFile(file, "video/mp4", `bytes=${contents.length}-`);
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get("content-range")).toBe(`bytes */${contents.length}`);
	});
	test.each(["abort", "cancel", "read error"])("releases the media handle on %s", async (kind) => {
		const dir = await fs.mkdtemp(path.join(root, "media-body-"));
		const file = path.join(dir, "partial.mp4");
		await fs.writeFile(file, new Uint8Array(3 * 512 * 1024));
		const handle = await fs.open(file, "r");
		const open = spyOn(fs, "open").mockResolvedValueOnce(handle);
		const closed = Promise.withResolvers<void>();
		const closeFile = handle.close.bind(handle);
		const close = spyOn(handle, "close").mockImplementation(async () => {
			await closeFile();
			closed.resolve();
		});
		const readFile = handle.read.bind(handle);
		const failRead = Promise.withResolvers<void>();
		const read = kind === "read error"
			? spyOn(handle, "read").mockImplementationOnce(readFile).mockImplementationOnce(async () => {
				await failRead.promise;
				throw new Error("disk read failed");
			})
			: undefined;
		const controller = new AbortController();
		try {
			const response = await streamMediaFile(file, "video/mp4", null, controller.signal);
			const body = response.body!.getReader();
			expect((await body.read()).value?.byteLength).toBe(512 * 1024);
			if (kind === "abort") {
				controller.abort();
				expect(close).toHaveBeenCalledTimes(1);
				await expect(body.read()).rejects.toThrow("abort");
			} else if (kind === "cancel") {
				await body.cancel();
			} else {
				const error = body.read().then(() => null, (reason: unknown) => reason);
				failRead.resolve();
				expect(await error).toMatchObject({ message: "disk read failed" });
			}
			await closed.promise;
			expect(close).toHaveBeenCalledTimes(1);
			await fs.unlink(file);
			await fs.rmdir(dir);
		} finally {
			failRead.resolve();
			controller.abort();
			open.mockRestore();
			read?.mockRestore();
			close.mockRestore();
			await closeFile().catch(() => {});
		}
	});
	test("missing media bytes return 404 and a repeat upload preserves saved metadata", async () => {
		const projectId = "restored-media";
		const mediaId = "clip";
		const dir = path.join(projectDir(projectId), "media");
		const file = path.join(dir, "clip.mp4");
		const metadataPath = path.join(dir, "_metadata", "clip.json");
		const upload = { id: mediaId, fileName: "clip.mp4", fileType: "video/mp4" };
		const stored = { ...upload, diskFile: "clip.mp4", staged: true, words: [{ text: "hello" }] };
		await atomicWrite(metadataPath, JSON.stringify(stored));

		expect((await mediaResponse(projectId, mediaId, null)).status).toBe(404);
		await saveMedia(projectId, mediaId, upload, new Blob(["restored"]).stream());
		expect(await fs.readFile(file, "utf8")).toBe("restored");
		expect(await (await mediaResponse(projectId, mediaId, null)).text()).toBe("restored");
		expect(await readJson(metadataPath)).toEqual(stored);
	});

	test("retries transient Windows lock errors with backoff, not other errors", async () => {
		const delays: number[] = [];
		const sleep = async (ms: number) => { delays.push(ms); };
		const locked = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
		let calls = 0;
		const value = await retryTransient(async () => {
			if (++calls < 4) throw locked(["EPERM", "EBUSY", "EACCES"][calls - 1]);
			return "renamed";
		}, { sleep });
		expect(value).toBe("renamed");
		expect(delays).toEqual([10, 20, 40]);

		calls = 0;
		await expect(retryTransient(async () => { calls++; throw locked("EPERM"); }, { attempts: 3, sleep })).rejects.toThrow("EPERM");
		expect(calls).toBe(3);

		calls = 0;
		await expect(retryTransient(async () => { calls++; throw locked("ENOSPC"); }, { sleep })).rejects.toThrow("ENOSPC");
		expect(calls).toBe(1);
	});
	test("concurrent writes to one file are serialized while it is being read", async () => {
		const file = path.join(projectDir("project-2"), "media", "_metadata", "logo.json");
		const reads: Promise<unknown>[] = [];
		await Promise.all(
			Array.from({ length: 40 }, (_, n) => {
				reads.push(readJson(file));
				return atomicWrite(file, JSON.stringify({ n, pad: "x".repeat(20000) }));
			}),
		);
		await Promise.all(reads);
		expect((await readJson(file)).n).toBe(39);
		expect(
			(await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});
	test("removing media also deletes a file whose metadata was never written", async () => {
		const dir = path.join(projectDir("project-3"), "media");
		await fs.mkdir(path.join(dir, "_metadata"), { recursive: true });
		// A save that wrote the file, then failed writing its metadata.
		await fs.writeFile(path.join(dir, "half.png"), "png");
		await fs.writeFile(path.join(dir, "other.png"), "png");
		await removeMedia("project-3", "half");
		expect((await fs.readdir(dir)).sort()).toEqual(["_metadata", "other.png"]);
		// With metadata: the file it names and the metadata go.
		await saveMedia("project-3", "whole", { id: "whole", fileName: "w.jpg", fileType: "image/jpeg" }, new Blob(["jpg"]).stream());
		await removeMedia("project-3", "whole");
		expect((await fs.readdir(dir)).sort()).toEqual(["_metadata", "other.png"]);
		expect(await fs.readdir(path.join(dir, "_metadata"))).toEqual([]);
	});
});
