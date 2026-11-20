import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TScene, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { defaultExportName, parseExportRequest, safeName } = await import("./export");
const { saveExport } = await import("./export-server");
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

	test("file names keep letters and digits (any language) and never name a folder", () => {
		expect(safeName("Klip: lucu / banget?")).toBe("Klip- lucu - banget");
		expect(safeName("../../etc")).toBe("etc");
		expect(defaultExportName("Ulang tahun", new Date(2026, 10, 20, 14, 5, 9))).toBe("Ulang tahun 2026-11-20 14-05-09");
	});
});

describe("saving an export", () => {
	test("streams into the exports folder and never overwrites an earlier export", async () => {
		const os = await import("node:os");
		const fs = (await import("node:fs")).promises;
		const path = await import("node:path");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exports-"));
		const body = (text: string) => new Blob([text]).stream();
		try {
			expect(await saveExport({ dir, name: "final", format: "mp4", body: body("one") })).toBe("final.mp4");
			expect(await saveExport({ dir, name: "final", format: "mp4", body: body("two") })).toBe("final (2).mp4");
			expect(await fs.readFile(path.join(dir, "final.mp4"), "utf8")).toBe("one");
			expect(await saveExport({ dir, name: "x", format: "mov", body: body("no") })).toBeNull();
			expect((await fs.readdir(dir)).sort()).toEqual(["final (2).mp4", "final.mp4"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the export poller", () => {
	afterEach(() => EditorCore.reset());

	test("exports the root timeline once per rev and reports progress and the file", async () => {
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		editor.save.stop();
		const clip = { id: "v", agentId: "v", type: "video", name: "v", mediaId: "m", startTime: T(0), duration: T(2), trimStart: T(0), trimEnd: T(0), params: {} } as unknown as VideoElement;
		const scenes = [{ id: "main", name: "Main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0), tracks: { main: { id: "t", name: "Main", type: "video", muted: false, hidden: false, elements: [clip] }, overlay: [], audio: [] } } as unknown as TScene];
		editor.project.setActiveProject({ project: { metadata: { id: "p", name: "My clip", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } } } as unknown as TProject });
		editor.scenes.setScenes({ scenes, activeSceneId: "main" });
		(editor.project as any).isLoading = false;
		(editor.media as any).loadedProjectId = "p";
		(editor.media as any).isLoading = false;
		let exportedWith: any = null;
		(editor.project as any).export = async ({ options }: { options: unknown }) => {
			exportedWith = options;
			return { success: true, buffer: new ArrayBuffer(10) };
		};
		const results: any[] = [];
		const files: string[] = [];
		const store = new Map<string, string>();
		const previousStorage = (globalThis as any).localStorage;
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
			const u = String(url);
			if (u === "/api/agent/export-request") return new Response(JSON.stringify({ rev: "e1", name: "final" }));
			if (u.startsWith("/api/agent/export-file")) {
				files.push(u);
				return new Response(JSON.stringify({ file: "exports/final.mp4" }));
			}
			if (u === "/api/agent/export-result") results.push(JSON.parse(String(init?.body)));
			return new Response("{}");
		}) as typeof fetch;
		try {
			await pollExport();
			await pollExport(); // once per rev
		} finally {
			globalThis.fetch = realFetch;
			(globalThis as any).localStorage = previousStorage;
		}
		expect(exportedWith).toMatchObject({ format: "mp4", quality: "high", includeAudio: true, sceneId: "main" });
		expect(files.length).toBe(1);
		expect(files[0]).toContain("name=final");
		expect(results[0]).toMatchObject({ rev: "e1", projectId: "p", status: "exporting", progress: 0 });
		expect(results.at(-1)).toMatchObject({ rev: "e1", status: "done", file: "exports/final.mp4", bytes: 10, width: 1080, height: 1920, fps: 30, duration: 2 });
	});
});
