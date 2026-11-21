import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ALL_FORMATS, BufferSource, CanvasSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, Output } from "mediabunny";
import type { CompoundElement, LibraryAudioElement, TScene, UploadAudioElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { ExportFormat } from "@/export";
import type { MediaAsset } from "@/media/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { defaultExportName, parseExportRequest, safeName } = await import("./export");
const { CLAIM_MS, handleExportFile, handleExportResult, readTextLimited, saveExport, writeExportResult } = await import("./export-server");
const { holdMediaUrls, revokeMediaUrl } = await import("@/media/url-release");
const { EditorCore } = await import("@/core");
const { pollExport, retryMissingMedia } = await import("./bridge");
const { storageService } = await import("@/services/storage/service");
const { CanvasRenderer } = await import("@/services/renderer/canvas-renderer");
const { RootNode } = await import("@/services/renderer/nodes/root-node");
const { SceneExporter } = await import("@/services/renderer/scene-exporter");
const { resolveRenderTree } = await import("@/services/renderer/resolve");
const { videoCache } = await import("@/services/video-cache/service");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;

class TestAudioContext {
	async close() {}
	async decodeAudioData() {
		throw new Error("Invalid audio");
	}
}

async function withCanvas(run: () => Promise<void>, extraGlobals: Record<string, unknown> = {}) {
	class TestCanvas {
		width = 0;
		height = 0;
	}
	const globals = {
		HTMLCanvasElement: TestCanvas,
		document: { createElement: () => new TestCanvas() },
		...extraGlobals,
	};
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	try {
		await run();
	} finally {
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("export frame timing", () => {
	// A single black 16 × 16 keyframe in each codec, supplied in place of browser encoding.
	const packets = {
		mp4: "AAAAAWdkAAqs2V7ARAAAAwAEAAADAMg8SJZYAAAAAWjr48siwAAAAWWIhAAr//72c3wKa22xgQ==",
		webm: "gkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///UiMAA==",
	};

	test.each<{
		format: ExportFormat; seconds: number; count: number; expectedDuration: number;
	}>([
		{ format: "mp4", seconds: 1 / 30, count: 1, expectedDuration: 1 / 30 },
		{ format: "mp4", seconds: 0.099, count: 3, expectedDuration: 0.099 },
		{ format: "webm", seconds: 0.099, count: 3, expectedDuration: 0.125 },
	])("$format exports $count frame(s) from a $seconds-second timeline", ({ format, seconds, count, expectedDuration }) =>
		withCanvas(async () => {
			const render = spyOn(CanvasRenderer.prototype, "render").mockResolvedValue(undefined);
			const track = new EncodedVideoPacketSource(format === "mp4" ? "avc" : "vp9");
			const addVideoTrack = Output.prototype.addVideoTrack;
			const addTrack = spyOn(Output.prototype, "addVideoTrack").mockImplementation(function (this: Output, _, metadata) {
				return addVideoTrack.call(this, track, metadata);
			});
			const close = spyOn(CanvasSource.prototype, "close").mockImplementation(() => track.close());
			const data = Uint8Array.from(atob(packets[format]), (byte) => byte.charCodeAt(0));
			const add = spyOn(CanvasSource.prototype, "add").mockImplementation((timestamp, duration = 0) =>
				track.add(new EncodedPacket(data, "key", timestamp, duration), {
					decoderConfig: { codec: format === "mp4" ? "avc1.64000a" : "vp09.00.10.08", codedWidth: 16, codedHeight: 16 },
				}),
			);
			try {
				const exporter = new SceneExporter({ width: 16, height: 16, fps: { numerator: 24, denominator: 1 }, format, quality: "high" });
				const buffer = await exporter.export({ rootNode: new RootNode({ duration: T(seconds) }) });
				expect(render).toHaveBeenCalledTimes(count);
				if (!buffer) throw new Error("Expected an exported video");
				const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
				try {
					const video = await input.getPrimaryVideoTrack();
					if (!video) throw new Error("Expected a video track");
					const samples = await Array.fromAsync(new EncodedPacketSink(video).packets());
					expect(samples).toHaveLength(count);
					const tolerance = format === "mp4" ? 0.00002 : 0.001;
					expect(Math.abs(await video.computeDuration() - expectedDuration)).toBeLessThanOrEqual(tolerance);
				} finally {
					input.dispose();
				}
			} finally {
				add.mockRestore();
				close.mockRestore();
				addTrack.mockRestore();
				render.mockRestore();
			}
		}));

	test("a one-hour fractional-rate export rounds each render time independently", () =>
		withCanvas(async () => {
			let count = 0;
			let lastRender = -1;
			let lastSampleEnd = -1;
			const render = spyOn(CanvasRenderer.prototype, "render").mockImplementation(async ({ time }) => {
				lastRender = time;
			});
			const start = spyOn(Output.prototype, "start").mockResolvedValue(undefined);
			const close = spyOn(CanvasSource.prototype, "close").mockImplementation(() => {});
			const finalize = spyOn(Output.prototype, "finalize").mockResolvedValue(undefined);
			const add = spyOn(CanvasSource.prototype, "add").mockImplementation(async (timestamp, duration = 0) => {
				count++;
				lastSampleEnd = timestamp + duration;
			});
			try {
				const fps = { numerator: 2997, denominator: 100 };
				const exporter = new SceneExporter({ width: 16, height: 16, fps, format: "mp4", quality: "high" });
				await exporter.export({ rootNode: new RootNode({ duration: T(3600) }) });
				expect(count).toBe(107_892);
				expect(lastRender).toBe(431_995_996);
				expect(lastSampleEnd).toBeCloseTo(3600, 8);
			} finally {
				add.mockRestore();
				finalize.mockRestore();
				close.mockRestore();
				start.mockRestore();
				render.mockRestore();
			}
		}));
});

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

	test("an exception in an export-start listener releases the slot", async () => {
		const { renderer } = EditorCore.getInstance();
		const unsubscribe = renderer.subscribe(() => {
			if (renderer.isExportRunning()) throw new Error("Listener failed");
		});
		try {
			await expect(renderer.exportProject({ options: { format: "mp4", quality: "high" } })).rejects.toThrow("Listener failed");
			expect(renderer.isExportRunning()).toBe(false);
		} finally {
			unsubscribe();
		}
	});
});

describe("the export poller", () => {
	afterEach(() => EditorCore.reset());

	const clip = (seconds: number): VideoElement => ({ id: "v", agentId: "v", type: "video", name: "Clip", mediaId: "m", startTime: T(0), duration: T(seconds), trimStart: T(0), trimEnd: T(0), params: {} });
	const sceneWith = (id: string, element: VideoElement | CompoundElement): TScene => ({
		id, name: id, isMain: id === "main", bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { main: { id: `track-${id}`, name: "Main", type: "video", muted: false, hidden: false, elements: [element] }, overlay: [], audio: [] },
	});
	const videoAsset: MediaAsset = { id: "m", name: "Clip", type: "video", file: new File(["video"], "clip.mp4"), url: "blob:video" };
	const open = (id: string, seconds = 2, { width = 1080, missing = false, nested = false } = {}) => {
		const editor = EditorCore.getInstance();
		const video = clip(seconds);
		const compound = (sceneId: string): CompoundElement => ({
			id: `to-${sceneId}`, name: sceneId, type: "compound", sceneId, params: {},
			startTime: video.startTime, duration: video.duration, trimStart: video.trimStart, trimEnd: video.trimEnd,
		});
		const scenes: TScene[] = nested
			? [sceneWith("main", compound("outer")), { ...sceneWith("outer", compound("inner")), kind: "compound" }, { ...sceneWith("inner", video), kind: "compound" }]
			: [sceneWith("main", video)];
		const project: TProject = {
			metadata: { id, name: "My clip", duration: video.duration, createdAt: new Date(0), updatedAt: new Date(0) },
			scenes, currentSceneId: "main", version: 1,
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width, height: 1920 }, background: { type: "color", color: "#000000" } },
		};
		editor.project.setActiveProject({ project });
		editor.scenes.setScenes({ scenes, activeSceneId: "main" });
		(editor.project as any).isLoading = false;
		editor.media.setAssets({ assets: missing ? [] : [videoAsset] });
		editor.media.markProjectMediaLoaded({ projectId: id });
		return editor;
	};

	type Log = { exports: any[]; posts: any[]; uploads: number; gets: number; result: () => Promise<any> };
	type Server = { request: unknown; onRequest?: () => void; onClaim?: () => void; result?: Record<string, unknown>; replyLost?: boolean; duringExport?: () => void; useRenderer?: boolean };
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
			if (!server.useRenderer) (editor.renderer as any).exportProject = async ({ options, onProgress, onCancel }: { options: { sceneId: string }; onProgress: (p: { progress: number }) => void; onCancel: () => boolean }) => {
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

	test("browser export reports nested missing media and accepts an explicit override", () =>
		withCanvas(async () => {
			const editor = open("p", 2, { missing: true, nested: true });
			editor.save.stop();
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			const readMedia = spyOn(storageService, "loadMediaAsset").mockResolvedValue(videoAsset);
			try {
				const options = { format: "mp4", quality: "high" } as const;
				const blocked = await editor.project.export({ options });
				expect(blocked).toMatchObject({ success: false, missingMedia: [{ id: "m", name: "Clip" }] });
				expect(encode).not.toHaveBeenCalled();
				const allowed = await editor.project.export({ options: { ...options, allowMissing: true } });
				expect(allowed.success).toBe(true);
				expect(encode).toHaveBeenCalledTimes(1);
				await editor.media.retryMissingMedia({ projectId: "p", failures: blocked.missingMedia });
				expect(readMedia).toHaveBeenCalledWith({ projectId: "p", id: "m" });
				expect((await editor.project.export({ options })).success).toBe(true);
			} finally {
				readMedia.mockRestore();
				encode.mockRestore();
			}
		}));

	test("browser export waits for a pending media load", () =>
		withCanvas(async () => {
			const editor = open("p", 2, { missing: true });
			editor.save.stop();
			const source = Promise.withResolvers<MediaAsset[]>();
			const load = spyOn(storageService, "loadAllMediaAssets").mockReturnValue(source.promise);
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			try {
				const loading = editor.media.loadProjectMedia({ projectId: "p" });
				const exporting = editor.project.export({ options: { format: "mp4", quality: "high" } });
				await Promise.resolve();
				expect(encode).not.toHaveBeenCalled();
				source.resolve([videoAsset]);
				await loading;
				expect((await exporting).success).toBe(true);
				expect(encode).toHaveBeenCalledTimes(1);
			} finally {
				source.resolve([videoAsset]);
				encode.mockRestore();
				load.mockRestore();
			}
		}));

	test("cancelling a browser export releases its slot while the media read is pending", async () => {
		const editor = open("p", 2, { missing: true });
		editor.save.stop();
		const source = Promise.withResolvers<MediaAsset[]>();
		const load = spyOn(storageService, "loadAllMediaAssets").mockReturnValue(source.promise);
		const loading = editor.media.loadProjectMedia({ projectId: "p" });
		const exporting = editor.project.export({ options: { format: "mp4", quality: "high" } });
		try {
			expect(editor.renderer.isExportRunning()).toBe(true);
			editor.project.cancelExport();
			const result = await Promise.race([exporting, Bun.sleep(0).then(() => "waiting for media")]);
			expect(result).toEqual({ success: false, cancelled: true });
			expect(editor.renderer.isExportRunning()).toBe(false);
			expect(editor.media.isLoadingMedia()).toBe(true);
		} finally {
			source.resolve([]);
			await loading;
			await exporting;
			load.mockRestore();
		}
	});

	test("an unavailable library sound is reported before encoding unless explicitly allowed", () =>
		withCanvas(async () => {
			const editor = open("p");
			editor.save.stop();
			editor.media.setAssets({ assets: [{ ...videoAsset, hasAudio: false }] });
			const [scene] = editor.scenes.getScenes();
			const sound: LibraryAudioElement = {
				id: "sound", type: "audio", sourceType: "library", sourceUrl: "/library/sound.mp3", name: "Library sound",
				startTime: T(0), duration: T(1), trimStart: T(0), trimEnd: T(0), params: {},
			};
			scene.tracks.audio = [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [sound] }];
			const fetchSound = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			try {
				const options = { format: "mp4", quality: "high", includeAudio: true } as const;
				expect(await editor.project.export({ options })).toMatchObject({
					success: false,
					missingMedia: [{ name: sound.name, sourceUrl: sound.sourceUrl, error: expect.stringContaining("404") }],
				});
				expect(encode).not.toHaveBeenCalled();
				expect((await editor.project.export({ options: { ...options, allowMissing: true } })).success).toBe(true);
				expect(encode).toHaveBeenCalledTimes(1);
				expect(fetchSound.mock.calls.map(([url]) => url)).toEqual([sound.sourceUrl, sound.sourceUrl]);
			} finally {
				encode.mockRestore();
				fetchSound.mockRestore();
			}
		}, { window: { AudioContext: TestAudioContext } }));

	test("cancelling mixdown aborts a pending library fetch and releases the export slot", () =>
		withCanvas(async () => {
			const editor = open("p");
			editor.save.stop();
			const [scene] = editor.scenes.getScenes();
			const sound: LibraryAudioElement = {
				id: "sound", type: "audio", sourceType: "library", sourceUrl: "/library/pending.mp3", name: "Pending sound",
				startTime: T(0), duration: T(1), trimStart: T(0), trimEnd: T(0), params: {},
			};
			scene.tracks.audio = [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [sound] }];
			const pending = Promise.withResolvers<Response>();
			const fetchSound = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
			const exporting = editor.project.export({ options: { format: "mp4", quality: "high", includeAudio: true } });
			try {
				expect(fetchSound).toHaveBeenCalled();
				const signal = fetchSound.mock.calls[0]?.[1]?.signal;
				signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
				editor.project.cancelExport();
				const result = await Promise.race([exporting, Bun.sleep(0).then(() => "waiting for audio")]);
				expect(result).toEqual({ success: false, cancelled: true });
				expect(signal?.aborted).toBe(true);
				expect(editor.renderer.isExportRunning()).toBe(false);
			} finally {
				pending.resolve(new Response(null, { status: 404 }));
				await exporting;
				fetchSound.mockRestore();
			}
		}, { window: { AudioContext: TestAudioContext } }));

	test("preflight checks enabled source audio even when its video track is hidden", () => {
		const editor = open("p", 2, { missing: true });
		editor.save.stop();
		const scenes = editor.scenes.getScenes();
		const scene = scenes[0];
		const track = scene.tracks.main;
		track.hidden = true;
		const video = { ...clip(2), isSourceAudioEnabled: true };
		track.elements = [video];
		const request = { format: "mp4", scene, scenes, canvasSize: { width: 1080, height: 1920 } } as const;
		expect(editor.renderer.checkExport({ ...request, includeAudio: false })).toBeNull();
		expect(editor.renderer.checkExport({ ...request, includeAudio: true })).toMatchObject({
			missingMedia: [{ id: video.mediaId }],
		});
		track.muted = true;
		expect(editor.renderer.checkExport({ ...request, includeAudio: true })).toBeNull();
		track.muted = false;
		video.isSourceAudioEnabled = false;
		expect(editor.renderer.checkExport({ ...request, includeAudio: true })).toBeNull();
	});

	test.each(["upload", "video"] as const)("an unreadable %s audio source requires an explicit override", (source) =>
		withCanvas(async () => {
			const editor = open("p");
			editor.save.stop();
			const soundAsset: MediaAsset = { id: "sound", name: "Uploaded sound", type: "audio", file: new File(["bad"], "sound.wav") };
			const [scene] = editor.scenes.getScenes();
			const sound: UploadAudioElement = {
				id: "audio", type: "audio", sourceType: "upload", mediaId: soundAsset.id, name: soundAsset.name,
				startTime: T(0), duration: T(1), trimStart: T(0), trimEnd: T(0), params: {},
			};
			if (source === "upload") {
				scene.tracks.audio = [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [sound] }];
			}
			editor.media.setAssets({ assets: [{ ...videoAsset, hasAudio: source === "video" }, soundAsset] });
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			const expected = source === "upload" ? soundAsset : videoAsset;
			try {
				const options = { format: "mp4", quality: "high", includeAudio: true } as const;
				const blocked = await editor.project.export({ options });
				expect(blocked).toMatchObject({
					success: false,
					missingMedia: [{ id: expected.id, name: expected.name }],
				});
				expect(encode).not.toHaveBeenCalled();
				const read = spyOn(storageService, "loadMediaAsset").mockResolvedValue(expected);
				try {
					await editor.media.retryMissingMedia({ projectId: "p", failures: blocked.missingMedia });
					expect(read).toHaveBeenCalledWith({ projectId: "p", id: expected.id });
				} finally {
					read.mockRestore();
				}
				expect((await editor.project.export({ options: { ...options, allowMissing: true } })).success).toBe(true);
			} finally {
				encode.mockRestore();
			}
		}, { window: { AudioContext: TestAudioContext } }));

	test("visible references must resolve to a source of the correct type", () => {
		const editor = open("p");
		editor.save.stop();
		editor.media.setAssets({ assets: [{ ...videoAsset, type: "image" }] });
		const scenes = editor.scenes.getScenes();
		expect(editor.renderer.checkExport({
			format: "mp4", scene: scenes[0], scenes, canvasSize: { width: 1080, height: 1920 },
		})).toMatchObject({ missingMedia: [{ id: videoAsset.id }] });
	});

	test("a video decoder failure reports the asset and requires an override", () =>
		withCanvas(async () => {
			const editor = open("p", 0.1);
			editor.save.stop();
			const decode = spyOn(videoCache, "getFrameAt").mockImplementation(async ({ throwOnSeekError }) => {
				if (throwOnSeekError) throw new Error("Invalid video packet");
				return null;
			});
			const render = spyOn(CanvasRenderer.prototype, "render").mockImplementation(function (this: InstanceType<typeof CanvasRenderer>, { node, time }) {
				return resolveRenderTree({ node, time, renderer: this });
			});
			const start = spyOn(Output.prototype, "start").mockResolvedValue(undefined);
			const cancel = spyOn(Output.prototype, "cancel").mockResolvedValue(undefined);
			const finalize = spyOn(Output.prototype, "finalize").mockImplementation(async function (this: Output) {
				Object.defineProperty(this.target, "buffer", { value: new ArrayBuffer(10) });
			});
			const add = spyOn(CanvasSource.prototype, "add").mockResolvedValue(undefined);
			const close = spyOn(CanvasSource.prototype, "close").mockImplementation(() => {});
			try {
				const options = { format: "mp4", quality: "high" } as const;
				expect(await editor.project.export({ options })).toMatchObject({
					success: false, missingMedia: [{ id: videoAsset.id, error: "Invalid video packet" }],
				});
				expect(cancel).toHaveBeenCalledTimes(1);
				expect(finalize).not.toHaveBeenCalled();
				expect(editor.renderer.isExportRunning()).toBe(false);
				expect((await editor.project.export({ options: { ...options, allowMissing: true } })).success).toBe(true);
				expect(decode).toHaveBeenCalledTimes(2);
			} finally {
				close.mockRestore();
				add.mockRestore();
				finalize.mockRestore();
				cancel.mockRestore();
				start.mockRestore();
				render.mockRestore();
				decode.mockRestore();
			}
		}));

	test("preflight checks only media used by the selected export", () =>
		withCanvas(async () => {
			const editor = open("p", 2, { nested: true });
			editor.save.stop();
			const [root, outer, inner] = editor.scenes.getScenes();
			const missingClip = { ...clip(1), mediaId: "trimmed-video" };
			inner.tracks.main.elements = [missingClip];
			// Outer shows the second half of inner. The missing clip ends exactly at the trim.
			outer.tracks.main.elements = outer.tracks.main.elements.map((element) => ({
				...element, duration: T(1), trimStart: T(1),
			}));
			root.tracks.main.elements.push({ ...clip(2), id: "hidden", mediaId: "hidden-clip", hidden: true, isSourceAudioEnabled: false });
			root.tracks.overlay.push({
				...root.tracks.main, id: "hidden-track", hidden: true,
				elements: [{ ...clip(2), mediaId: "hidden-track-video", isSourceAudioEnabled: false }],
			});
			const audio: UploadAudioElement = {
				id: "sound", type: "audio", sourceType: "upload", mediaId: "missing-audio", name: "Uploaded sound",
				startTime: T(0), duration: T(1), trimStart: T(0), trimEnd: T(0), params: {},
			};
			root.tracks.audio = [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [audio] }];
			inner.tracks.audio = [{
				...root.tracks.audio[0], id: "nested-audio",
				elements: [{ ...audio, mediaId: "trimmed-audio" }],
			}];
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			try {
				const options = { format: "mp4", quality: "high" } as const;
				expect((await editor.project.export({ options: { ...options, includeAudio: false } })).success).toBe(true);
				expect((await editor.project.export({ options: { ...options, includeAudio: true } })).missingMedia?.map(({ id }) => id))
					.toEqual(["missing-audio"]);
				expect(encode).toHaveBeenCalledTimes(1);
			} finally {
				encode.mockRestore();
			}
		}));

	test("the retry helper can restore references listed only in the folder export result", () =>
		withCanvas(async () => {
			const server = { useRenderer: true, request: { rev: "e1", includeAudio: false } };
			const read = spyOn(storageService, "loadMediaAsset").mockResolvedValue(videoAsset);
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			try {
				await withServer(server, async (log) => {
					const editor = open("p", 2, { missing: true });
					expect(editor.media.getMissingMedia()).toEqual([]);
					await pollExport();
					const { missingMedia } = await log.result();
					expect(missingMedia).toMatchObject([{ id: videoAsset.id }]);
					await retryMissingMedia(missingMedia);
					expect(read).toHaveBeenCalledWith({ projectId: "p", id: videoAsset.id });
					server.request = { ...server.request, rev: "e2" };
					await pollExport();
					expect(await log.result()).toMatchObject({ status: "done", rev: "e2" });
				});
			} finally {
				encode.mockRestore();
				read.mockRestore();
			}
		}));

	test("folder export reports missing references before claiming the request, and honors an override", () =>
		withCanvas(async () => {
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			const server = { useRenderer: true, request: { rev: "e1", includeAudio: false, allowMissing: false } };
			try {
				await withServer(server, async (log) => {
					open("p", 2, { missing: true, nested: true });
					await pollExport();
					expect(log.posts.map((post) => post.status)).toEqual(["error"]);
					expect(await log.result()).toMatchObject({ status: "error", missingMedia: [{ id: "m" }] });
					expect(encode).not.toHaveBeenCalled();
					server.request = { ...server.request, rev: "e2", allowMissing: true };
					await pollExport();
					expect(await log.result()).toMatchObject({ status: "done", rev: "e2" });
					expect(log.uploads).toBe(1);
				});
			} finally {
				encode.mockRestore();
			}
		}));

	test("both export entry points refuse odd MP4 canvas dimensions before audio preparation", () =>
		withCanvas(async () => {
			const encode = spyOn(SceneExporter.prototype, "export").mockResolvedValue(new ArrayBuffer(10));
			const server = { request: { rev: "e1", format: "mp4", includeAudio: true }, useRenderer: true };
			try {
				await withServer(server, async (log) => {
					const editor = open("p", 2, { width: 1081 });
					const result = await editor.project.export({ options: { format: "mp4", quality: "high", includeAudio: true } });
					expect(result).toMatchObject({ success: false, error: expect.stringContaining("Choose WebM") });
					expect(editor.project.getExportState().progress).toBe(0);
					await pollExport();
					expect(log.posts.map((post) => post.status)).toEqual(["error"]);
					expect(await log.result()).toMatchObject({ status: "error", error: result.error });
					expect(log.uploads).toBe(0);
					expect(encode).not.toHaveBeenCalled();
					server.request = { rev: "e2", format: "webm", includeAudio: false };
					await pollExport();
					expect(await log.result()).toMatchObject({ status: "done", format: "webm", width: 1081 });
				});
			} finally {
				encode.mockRestore();
			}
		}));

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
