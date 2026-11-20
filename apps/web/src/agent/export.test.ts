import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TScene, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { defaultExportName, parseExportRequest, safeName } = await import("./export");
const { CLAIM_MS, handleExportFile, handleExportResult, readTextLimited, saveExport, writeExportResult } = await import("./export-server");
const { holdMediaUrls, revokeMediaUrl } = await import("@/media/url-release");
const { EditorCore } = await import("@/core");
const { pollExport } = await import("./bridge");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;

describe("export requests", () => {
	test("defaults and checks", () => {
		expect(parseExportRequest({ rev: "e1" })).toEqual({ rev: "e1", format: "mp4", quality: "high", includeAudio: true, allowMissing: false });
		expect(parseExportRequest({ rev: "e2", format: "webm", quality: "very_high", fps: 60, includeAudio: false, name: "final", projectId: "p" })).toMatchObject({ format: "webm", fps: 60, includeAudio: false, name: "final", projectId: "p" });
		expect(parseExportRequest({ rev: "e3", format: "mov" })).toContain("format");
		expect(parseExportRequest({ rev: "e4", fps: 0 })).toContain("fps");
		expect(parseExportRequest({ rev: "e5", name: "../.." })).toContain("name");
		expect(parseExportRequest({ rev: "bad rev" })).toBeNull();
		expect(parseExportRequest(null)).toBeNull();
	});

	test("file names keep letters and digits (any language) and never name a folder or a device", () => {
		expect(safeName("Klip: lucu / banget?")).toBe("Klip- lucu - banget");
		expect(safeName("../../etc")).toBe("etc");
		expect(safeName("con")).toBe("con_");
		expect(safeName("NUL.backup")).toBe("NUL_.backup");
		expect(safeName("COM1")).toBe("COM1_");
		expect(safeName("console")).toBe("console");
		expect(defaultExportName("Ulang tahun", new Date(2026, 10, 20, 14, 5, 9))).toBe("Ulang tahun 2026-11-20 14-05-09");
	});
});

describe("saving an export", () => {
	const body = (text: string) => new Blob([text]).stream();
	async function inTempDir(run: (dir: string, fs: typeof import("node:fs").promises, path: typeof import("node:path")) => Promise<void>) {
		const os = await import("node:os");
		const fs = (await import("node:fs")).promises;
		const path = await import("node:path");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exports-"));
		try {
			await run(dir, fs, path);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	test("streams into the exports folder and never overwrites an earlier export", () =>
		inTempDir(async (dir, fs, path) => {
			expect(await saveExport({ dir, name: "final", format: "mp4", body: body("one") })).toEqual({ file: "final.mp4", bytes: 3 });
			expect(await saveExport({ dir, name: "final", format: "mp4", body: body("two") })).toEqual({ file: "final (2).mp4", bytes: 3 });
			expect(await fs.readFile(path.join(dir, "final.mp4"), "utf8")).toBe("one");
			expect(await saveExport({ dir, name: "x", format: "mov", body: body("no") })).toMatchObject({ status: 400 });
			expect((await fs.readdir(dir)).sort()).toEqual(["final (2).mp4", "final.mp4"]);
		}));

	test("two saves of one name at once both keep their own file", () =>
		inTempDir(async (dir, fs, path) => {
			const saved = await Promise.all([saveExport({ dir, name: "same", format: "mp4", body: body("a") }), saveExport({ dir, name: "same", format: "mp4", body: body("b") })]);
			const files = saved.map((s) => ("file" in s ? s.file : s.error)).sort();
			expect(files).toEqual(["same (2).mp4", "same.mp4"]);
			const contents = await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), "utf8")));
			expect(contents.sort()).toEqual(["a", "b"]);
		}));

	test("refuses a body over the limit and leaves nothing behind", () =>
		inTempDir(async (dir, fs) => {
			expect(await saveExport({ dir, name: "big", format: "mp4", body: body("too long"), maxBytes: 3 })).toMatchObject({ status: 413 });
			expect(await fs.readdir(dir)).toEqual([]);
		}));

	test("refuses an exports folder that is a link", () =>
		inTempDir(async (dir, fs, path) => {
			const real = path.join(dir, "elsewhere");
			const link = path.join(dir, "exports");
			await fs.mkdir(real);
			await fs.symlink(real, link, "junction");
			expect(await saveExport({ dir: link, name: "x", format: "mp4", body: body("x") })).toMatchObject({ status: 403 });
			expect(await fs.readdir(real)).toEqual([]);
		}));

	test("works where hard links are not supported (FAT, exFAT, network drives)", async () => {
		const fsModule = await import("node:fs");
		const noLinks = spyOn(fsModule.promises, "link").mockImplementation(async () => {
			throw Object.assign(new Error("not supported"), { code: "EPERM" });
		});
		try {
			await inTempDir(async (dir, fs, path) => {
				expect(await saveExport({ dir, name: "f", format: "webm", body: body("one") })).toEqual({ file: "f.webm", bytes: 3 });
				expect(await saveExport({ dir, name: "f", format: "webm", body: body("two") })).toEqual({ file: "f (2).webm", bytes: 3 });
				expect(await fs.readFile(path.join(dir, "f.webm"), "utf8")).toBe("one");
				expect(await fs.readFile(path.join(dir, "f (2).webm"), "utf8")).toBe("two");
				expect((await fs.readdir(dir)).sort()).toEqual(["f (2).webm", "f.webm"]);
			});
		} finally {
			noLinks.mockRestore();
		}
	});

	test("request texts are limited while they are read", async () => {
		const post = (text: string, headers?: Record<string, string>) => new Request("http://x/", { method: "POST", body: text, headers });
		expect(await readTextLimited(post("hello"), 10)).toBe("hello");
		expect(await readTextLimited(post("x".repeat(20)), 10)).toBeNull();
		expect(await readTextLimited(post("hi", { "content-length": "99" }), 10)).toBeNull();
		const streamed = new Request("http://x/", { method: "POST", body: new Blob(["y".repeat(30)]).stream(), duplex: "half" } as RequestInit);
		expect(await readTextLimited(streamed, 10)).toBeNull();
	});
});

async function inTemp(run: (dir: string, fs: typeof import("node:fs").promises, path: typeof import("node:path")) => Promise<void>) {
	const os = await import("node:os");
	const fs = (await import("node:fs")).promises;
	const path = await import("node:path");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-"));
	try {
		await run(dir, fs, path);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("the result file", () => {
	test("a final answer is never replaced; a running export belongs to the tab that took it", () =>
		inTemp(async (workspace, fs, path) => {
			const t0 = 1_000_000;
			const write = (result: Record<string, unknown>, now?: number) => writeExportResult({ workspace, result: result as any, now });
			expect(await write({ rev: "e1", status: "exporting", tab: "a", progress: 0 }, t0)).toEqual({ ok: true });
			expect(await write({ rev: "e1", status: "exporting", tab: "b", progress: 0 }, t0 + 1000)).toEqual({ ok: false, reason: "claimed" });
			expect(await write({ rev: "e1", status: "exporting", tab: "a", progress: 0.5 }, t0 + 2000)).toEqual({ ok: true });
			// A tab that stopped reporting is taken to be gone.
			expect(await write({ rev: "e1", status: "exporting", tab: "b", progress: 0 }, t0 + 2000 + CLAIM_MS)).toEqual({ ok: true });
			expect(await write({ rev: "e1", status: "error", tab: "b", error: "x" }, t0 + 2000 + CLAIM_MS)).toEqual({ ok: true });
			expect(await write({ rev: "e1", status: "exporting", tab: "a", progress: 0.9 })).toEqual({ ok: false, reason: "answered" });
			expect(JSON.parse(await fs.readFile(path.join(workspace, "export-result.json"), "utf8"))).toMatchObject({ rev: "e1", status: "error", tab: "b" });
			// A new request starts over.
			expect(await write({ rev: "e2", status: "exporting", tab: "a" })).toEqual({ ok: true });
		}));

	test("the video and its final answer are written in one request; a finished request is not saved again", () =>
		inTemp(async (workspace, fs, path) => {
			const query = (rev: string) => new URLSearchParams({ rev, projectId: "p", tab: "a", name: "final", format: "mp4", result: JSON.stringify({ width: 1080, status: "exporting", file: "x" }) });
			const post = (rev: string) => new Request(`http://x/api/agent/export-file?${query(rev)}`, { method: "POST", body: "video" });
			const first = await handleExportFile(post("e1"), workspace);
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({ file: "exports/final.mp4", bytes: 5 });
			expect(JSON.parse(await fs.readFile(path.join(workspace, "export-result.json"), "utf8"))).toMatchObject({ rev: "e1", projectId: "p", tab: "a", status: "done", file: "exports/final.mp4", bytes: 5, width: 1080 });
			const again = await handleExportFile(post("e1"), workspace);
			expect(again.status).toBe(409);
			expect(await again.json()).toMatchObject({ answered: true });
			expect(await fs.readdir(path.join(workspace, "exports"))).toEqual(["final.mp4"]);
			// "done" only comes with the video.
			expect((await handleExportResult(new Request("http://x/", { method: "POST", body: JSON.stringify({ rev: "e2", status: "done" }) }), workspace)).status).toBe(400);
			expect((await handleExportResult(new Request("http://x/", { method: "POST", body: "{" }), workspace)).status).toBe(400);
		}));
});

describe("one export at a time", () => {
	afterEach(() => EditorCore.reset());

	test("the renderer refuses a second export while one runs", async () => {
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		(editor.renderer as any).exportRunning = true;
		const result = await editor.renderer.exportProject({ options: { format: "mp4", quality: "high" } });
		expect(result.success).toBe(false);
		expect(result.error).toContain("Another export is running");
	});

	test("while it exports, the editor hears of it and media URLs stay usable", async () => {
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		const revoked: string[] = [];
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
			revoked.push(url);
		});
		let heard = 0;
		const unsubscribe = editor.renderer.subscribe(() => heard++);
		let during: Record<string, unknown> = {};
		(editor.renderer as any).runExport = async () => {
			during = { running: editor.renderer.isExportRunning(), heard };
			revokeMediaUrl("blob:removed-meanwhile");
			during.revoked = [...revoked];
			return { success: false, error: "x" };
		};
		try {
			await editor.renderer.exportProject({ options: { format: "mp4", quality: "high" } });
		} finally {
			unsubscribe();
			revoke.mockRestore();
		}
		expect(during).toEqual({ running: true, heard: 1, revoked: [] });
		expect(revoked).toEqual(["blob:removed-meanwhile"]);
		expect(heard).toBe(2);
		expect(editor.renderer.isExportRunning()).toBe(false);
	});

	test("media URLs are revoked once no export holds them", () => {
		const revoked: string[] = [];
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
			revoked.push(url);
		});
		try {
			revokeMediaUrl("blob:a");
			expect(revoked).toEqual(["blob:a"]);
			const first = holdMediaUrls();
			const second = holdMediaUrls();
			revokeMediaUrl("blob:b");
			first();
			first(); // a release counts once
			expect(revoked).toEqual(["blob:a"]);
			second();
			expect(revoked).toEqual(["blob:a", "blob:b"]);
		} finally {
			revoke.mockRestore();
		}
	});
});

describe("the export poller", () => {
	afterEach(() => EditorCore.reset());

	const clip = (seconds: number) => ({ id: "v", agentId: "v", type: "video", name: "v", mediaId: "m", startTime: T(0), duration: T(seconds), trimStart: T(0), trimEnd: T(0), params: {} }) as unknown as VideoElement;
	const scenesWith = (seconds: number) => [{ id: "main", name: "Main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0), tracks: { main: { id: "t", name: "Main", type: "video", muted: false, hidden: false, elements: [clip(seconds)] }, overlay: [], audio: [] } } as unknown as TScene];
	const open = (id: string, seconds = 2) => {
		const editor = EditorCore.getInstance();
		const scenes = scenesWith(seconds);
		editor.project.setActiveProject({ project: { metadata: { id, name: "My clip", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } } } as unknown as TProject });
		editor.scenes.setScenes({ scenes, activeSceneId: "main" });
		(editor.project as any).isLoading = false;
		(editor.media as any).loadedProjectId = id;
		(editor.media as any).isLoading = false;
	};

	type Log = { exports: any[]; posts: any[]; uploads: number; gets: number; result: () => Promise<any> };
	type Server = { request: unknown; onRequest?: () => void; onClaim?: () => void; result?: Record<string, unknown>; replyLost?: boolean; duringExport?: () => void };
	/** A fresh editor with one project, a fake export, and the real server handlers on a temporary workspace. */
	const withServer = (server: Server, run: (log: Log) => Promise<void>) =>
		inTemp(async (workspace, fs, path) => {
			EditorCore.reset();
			const editor = EditorCore.getInstance();
			editor.save.stop();
			open("p");
			if (server.result) await fs.writeFile(path.join(workspace, "export-result.json"), JSON.stringify(server.result));
			const log: Log = {
				exports: [],
				posts: [],
				uploads: 0,
				gets: 0,
				result: async () => {
					try {
						return JSON.parse(await fs.readFile(path.join(workspace, "export-result.json"), "utf8"));
					} catch {
						return null;
					}
				},
			};
			(editor.renderer as any).exportProject = async ({ options, onProgress, onCancel }: { options: { sceneId: string }; onProgress: (p: { progress: number }) => void; onCancel: () => boolean }) => {
				// What the real export reads at its start: the scene and its clip's length.
				const scene = editor.scenes.getScenes().find((s) => s.id === options.sceneId);
				log.exports.push({ options, duration: scene?.tracks.main.elements[0]?.duration });
				onProgress({ progress: 0.5 });
				server.duringExport?.();
				if (onCancel()) return { success: false, cancelled: true };
				return { success: true, buffer: new ArrayBuffer(10) };
			};
			const store = new Map<string, string>();
			const previousStorage = (globalThis as any).localStorage;
			(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
				const u = String(url);
				if (u === "/api/agent/export-request") {
					log.gets++;
					server.onRequest?.();
					return new Response(JSON.stringify(server.request));
				}
				if (u === "/api/agent/export-result") {
					log.posts.push(JSON.parse(String(init?.body)));
					if (log.posts.length === 1) server.onClaim?.();
					return handleExportResult(new Request("http://x/", { method: "POST", body: String(init?.body) }), workspace);
				}
				if (u.startsWith("/api/agent/export-file")) {
					log.uploads++;
					const response = await handleExportFile(new Request(`http://x${u}`, { method: "POST", body: init?.body as ArrayBuffer }), workspace);
					if (server.replyLost) throw new TypeError("network error");
					return response;
				}
				return new Response("{}");
			}) as typeof fetch;
			try {
				await run(log);
			} finally {
				globalThis.fetch = realFetch;
				(globalThis as any).localStorage = previousStorage;
			}
		});

	test("exports the root timeline once per rev; the file and its answer land in the workspace", () =>
		withServer({ request: { rev: "e1", name: "final" } }, async (log) => {
			await pollExport();
			await pollExport(); // once per rev
			expect(log.exports.length).toBe(1);
			expect(log.exports[0].options).toMatchObject({ format: "mp4", quality: "high", includeAudio: true, sceneId: "main" });
			expect(log.uploads).toBe(1);
			expect(log.posts[0]).toMatchObject({ rev: "e1", projectId: "p", status: "exporting", progress: 0 });
			expect(await log.result()).toMatchObject({ rev: "e1", projectId: "p", status: "done", file: "exports/final.mp4", bytes: 10, width: 1080, height: 1920, fps: 30, duration: 2 });
		}));

	test("takes the editor as it is once the request has arrived", () =>
		withServer({ request: { rev: "e1" }, onRequest: () => open("p", 5) }, async (log) => {
			// The clip grew while the request was read: the export and the answer both use the new length.
			await pollExport();
			expect(log.exports[0].duration).toBe(T(5));
			expect(await log.result()).toMatchObject({ status: "done", duration: 5 });
		}));

	test("takes the editor as it is once the request is taken", () =>
		withServer({ request: { rev: "e1" }, onClaim: () => open("p", 7) }, async (log) => {
			await pollExport();
			expect(log.exports[0].duration).toBe(T(7));
			expect(await log.result()).toMatchObject({ status: "done", duration: 7 });
		}));

	test("a project switch while the request is read leaves the request alone", () =>
		withServer({ request: { rev: "e1", projectId: "p" }, onRequest: () => open("q") }, async (log) => {
			await pollExport();
			expect(log.exports.length).toBe(0);
			expect(log.posts.length).toBe(0);
			expect(await log.result()).toBeNull();
		}));

	test("waits while another export runs", () =>
		withServer({ request: { rev: "e1" } }, async (log) => {
			(EditorCore.getInstance().renderer as any).isExportRunning = () => true;
			await pollExport();
			expect(log.gets).toBe(0);
			expect(log.exports.length).toBe(0);
		}));

	test("leaves a request another tab is exporting; takes it over once that tab is gone", async () => {
		await withServer({ request: { rev: "e1" }, result: { rev: "e1", status: "exporting", tab: "other", updatedAt: new Date().toISOString() } }, async (log) => {
			await pollExport();
			expect(log.exports.length).toBe(0);
			expect(await log.result()).toMatchObject({ tab: "other" });
		});
		await withServer({ request: { rev: "e1" }, result: { rev: "e1", status: "exporting", tab: "other", updatedAt: new Date(Date.now() - CLAIM_MS - 1000).toISOString() } }, async (log) => {
			await pollExport();
			expect(log.exports.length).toBe(1);
			expect(await log.result()).toMatchObject({ status: "done" });
		});
	});

	test("a request answered before (for example before a reload) is not exported again", () =>
		withServer({ request: { rev: "e1" }, result: { rev: "e1", status: "done", file: "exports/old.mp4" } }, async (log) => {
			await pollExport();
			await pollExport();
			expect(log.exports.length).toBe(0);
			expect(log.posts.length).toBe(1); // refused once, then known as answered
			expect(await log.result()).toMatchObject({ status: "done", file: "exports/old.mp4" });
		}));

	test("a lost reply after the video was saved keeps its answer and is not exported again", () =>
		withServer({ request: { rev: "e1", name: "final" }, replyLost: true }, async (log) => {
			await pollExport();
			await pollExport();
			expect(log.exports.length).toBe(1);
			expect(log.uploads).toBe(1);
			expect(log.posts.map((p) => p.status)).toEqual(["exporting", "error"]); // the error is refused
			expect(await log.result()).toMatchObject({ status: "done", file: "exports/final.mp4" });
		}));

	test("closing or reopening the project during the export stops it", () =>
		withServer({ request: { rev: "e1" }, duringExport: () => open("q") }, async (log) => {
			await pollExport();
			expect(log.uploads).toBe(0);
			expect(await log.result()).toMatchObject({ status: "error", error: expect.stringContaining("cancelled") });
		}));
});
