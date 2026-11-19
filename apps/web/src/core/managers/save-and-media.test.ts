import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { agentReadiness } = await import("@/agent/bridge");
const { StorageService, storageService } = await import("@/services/storage/service");

const asset = (id: string) => ({ id, name: id, type: "image", file: new File([id], `${id}.png`) }) as MediaAsset;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const project = (id: string, updatedAt: Date) => ({
	metadata: { id, name: id, thumbnail: "t", createdAt: new Date(0), updatedAt }, currentSceneId: "main",
	scenes: [{ id: "main", name: "Main", isMain: true, tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [], audio: [] }, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) }],
	settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
}) as unknown as TProject;

const stubbed = new Set<string>();
function stub(methods: Record<string, unknown>) {
	Object.assign(storageService, methods);
	for (const key of Object.keys(methods)) stubbed.add(key);
}
afterEach(() => {
	for (const key of stubbed) delete (storageService as any)[key];
	stubbed.clear();
	EditorCore.reset();
});

/** Loads `stored` through the real ProjectManager.loadProject (storage stubbed). */
async function load(stored: TProject, media: { assets?: MediaAsset[]; failed?: string[] } = {}) {
	const editor = EditorCore.getInstance();
	stub({
		ensureMigrations: async () => {},
		loadProject: async () => ({ project: structuredClone(stored) }),
		loadAllMediaAssets: async ({ onFailed }: { onFailed?: (f: { id: string; name: string; error: string }) => void }) => {
			for (const id of media.failed ?? []) onFailed?.({ id, name: id, error: "Media cannot be read" });
			return media.assets ?? [];
		},
		saveProject: async () => {},
	});
	await editor.project.loadProject({ id: stored.metadata.id });
	return editor;
}

describe("missing media", () => {
	test("a stored file that cannot be read is reported, not silently dropped, and can be retried", async () => {
		const editor = await load(project("p", new Date(0)), { assets: [asset("a")], failed: ["b"] });
		expect(editor.media.getMissingMedia()).toEqual([{ id: "b", name: "b", error: "Media cannot be read" }]);
		// Policy: loading finished, so ready; the agent sees what is missing and decides.
		expect(agentReadiness()).toMatchObject({ ready: true, mediaLoaded: true, missingMedia: [{ id: "b" }] });
		stub({ loadMediaAsset: async ({ id }: { id: string }) => asset(id) });
		expect(await editor.media.retryMissingMedia({ projectId: "p" })).toEqual([]);
		expect(editor.media.getAssets().map((m) => m.id).sort()).toEqual(["a", "b"]);
		expect(agentReadiness().missingMedia).toEqual([]);
	});

	test("the storage loader reports every unreadable file", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => (/\/media$/.test(String(url))
			? new Response(JSON.stringify([{ id: "a", name: "A", type: "image" }, { id: "b", name: "B", type: "image" }]))
			: String(url).endsWith("/b") ? new Response(null, { status: 404 }) : new Response(new Blob(["x"])))) as typeof fetch;
		try {
			const failed: string[] = [];
			const assets = await new StorageService().loadAllMediaAssets({ projectId: "p", onFailed: ({ id }) => failed.push(id) });
			expect(assets.map((a) => a.id)).toEqual(["a"]);
			expect(failed).toEqual(["b"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("failed saves", () => {
	const dirty = async (failures: number) => {
		const editor = await load(project("p", new Date(0)));
		(editor.save as any).retryDelaysMs = [5, 10];
		let calls = 0;
		editor.project.persistCurrentProject = async () => {
			calls++;
			const error = calls <= failures ? "EPERM: operation not permitted" : null;
			editor.save.recordPersisted({ projectId: "p", error });
			return error;
		};
		editor.save.markDirty();
		await editor.save.flush();
		return { editor, calls: () => calls };
	};

	test("are retried with backoff without any further edit", async () => {
		const { editor, calls } = await dirty(2);
		expect(agentReadiness()).toMatchObject({ ready: false, saveError: "EPERM: operation not permitted" });
		await wait(80);
		expect(calls()).toBe(3);
		expect(editor.save.getIsDirty()).toBe(false);
		expect(agentReadiness()).toMatchObject({ ready: true, saveError: null });
	});

	test("stop retrying after the backoff, then a manual retry saves", async () => {
		const { editor, calls } = await dirty(3);
		await wait(80);
		expect(calls()).toBe(3);
		await wait(40);
		expect(calls()).toBe(3);
		expect(agentReadiness().ready).toBe(false);
		await editor.save.retry();
		expect(calls()).toBe(4);
		expect(agentReadiness()).toMatchObject({ ready: true, saveError: null });
	});

	test("settle gives up at its deadline even while a save hangs", async () => {
		const editor = await load(project("p", new Date(0)));
		editor.project.persistCurrentProject = () => new Promise(() => {});
		editor.save.markDirty();
		const started = Date.now();
		expect(await editor.save.settle({ timeoutMs: 40 })).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe("savedAt", () => {
	test("is per project: from the stored project on load, then only from successful writes", async () => {
		const storedA = new Date("2026-01-01T00:00:00Z");
		const editor = await load(project("a", storedA));
		expect(agentReadiness().savedAt).toBe(storedA.toISOString());
		// Metadata changes that are not written do not move it.
		await editor.project.updateThumbnail({ thumbnail: "new" });
		expect(agentReadiness().savedAt).toBe(storedA.toISOString());
		const before = Date.now();
		expect(await editor.project.saveCurrentProject()).toBe(true);
		const savedA = agentReadiness().savedAt!;
		expect(Date.parse(savedA)).toBeGreaterThanOrEqual(before);

		const storedB = new Date("2025-06-01T00:00:00Z");
		await load(project("b", storedB));
		expect(agentReadiness().savedAt).toBe(storedB.toISOString());
		stub({ saveProject: async () => { throw new Error("disk full"); } });
		expect(await editor.project.saveCurrentProject()).toBe(false);
		expect(agentReadiness()).toMatchObject({ savedAt: storedB.toISOString(), saveError: "disk full" });
		expect(editor.save.getLastSavedAt("a")?.toISOString()).toBe(savedA);
	});
});

describe("saving does not re-render the editor", () => {
	test("persisting keeps the active project object and does not notify project subscribers", async () => {
		const editor = await load(project("p", new Date(0)));
		const active = editor.project.getActive();
		let notified = 0;
		const unsubscribe = editor.project.subscribe(() => notified++);
		expect(await editor.project.saveCurrentProject()).toBe(true);
		unsubscribe();
		expect(editor.project.getActive()).toBe(active);
		expect(notified).toBe(0);
	});
});

describe("media manifest cache", () => {
	test("keeps the two most recent projects and forgets closed ones", async () => {
		let lists = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			if (/\/media$/.test(String(url))) {
				lists++;
				return new Response(JSON.stringify([{ id: "m", name: "m", type: "image" }]));
			}
			return new Response(new Blob(["x"]));
		}) as typeof fetch;
		try {
			const service = new StorageService();
			for (const id of ["p1", "p2", "p3"]) await service.loadAllMediaAssets({ projectId: id });
			expect(lists).toBe(3);
			await service.loadMediaAsset({ projectId: "p3", id: "m" });
			await service.loadMediaAsset({ projectId: "p2", id: "m" });
			expect(lists).toBe(3);
			await service.loadMediaAsset({ projectId: "p1", id: "m" });
			expect(lists).toBe(4);
			service.forgetMediaManifest({ projectId: "p1" });
			await service.loadMediaAsset({ projectId: "p1", id: "m" });
			expect(lists).toBe(5);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("saving while projects switch", () => {
	test("a retry due while another project loads never writes the half-loaded timeline over the first one", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).retryDelaysMs = [20];
		const written: { id: string; elements: number }[] = [];
		let fail = true;
		editor.project.persistCurrentProject = async () => {
			const active = editor.project.getActive();
			written.push({ id: active.metadata.id, elements: editor.scenes.getScenes().length });
			const error = fail ? "EBUSY: resource busy" : null;
			editor.save.recordPersisted({ projectId: active.metadata.id, error });
			return error;
		};
		editor.save.markDirty();
		await editor.save.flush();
		expect(written).toEqual([{ id: "a", elements: 1 }]);
		// The retry is due in 20 ms, but project b takes longer to load.
		let release!: () => void;
		const slow = new Promise<void>((resolve) => { release = resolve; });
		stub({ loadProject: async () => { await slow; return { project: structuredClone(project("b", new Date(0))) }; } });
		fail = false;
		const loading = editor.project.loadProject({ id: "b" });
		await wait(60);
		// a's scenes are cleared and b is not in place yet: nothing may be written now.
		expect(written.filter((w) => w.elements === 0)).toEqual([]);
		release();
		await loading;
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(written.every((w) => w.elements > 0)).toBe(true);
	});

	test("a pause stops a pending timer; resume saves what is pending", async () => {
		const editor = await load(project("p", new Date(0)));
		let calls = 0;
		editor.project.persistCurrentProject = async () => {
			calls++;
			editor.save.recordPersisted({ projectId: "p", error: null });
			return null;
		};
		(editor.save as any).debounceMs = 10;
		editor.save.markDirty();
		editor.save.pause();
		await wait(40);
		expect(calls).toBe(0);
		editor.save.resume();
		await wait(40);
		expect(calls).toBe(1);
	});

	test("a save that fails after stop() schedules no retry on the stopped manager", async () => {
		const editor = await load(project("p", new Date(0)));
		(editor.save as any).retryDelaysMs = [10];
		let calls = 0;
		let finish!: (error: string | null) => void;
		editor.project.persistCurrentProject = () => {
			calls++;
			return new Promise((resolve) => { finish = (error) => { editor.save.recordPersisted({ projectId: "p", error }); resolve(error); }; });
		};
		editor.save.markDirty();
		const saving = editor.save.flush();
		await wait(5);
		editor.save.stop();
		finish("EPERM: operation not permitted");
		await saving;
		await wait(40);
		expect(calls).toBe(1);
	});
});

describe("staged media on disk", () => {
	test("staged media are saved marked, skipped by loads unless the timeline uses them, and promoted on commit", async () => {
		const realFetch = globalThis.fetch;
		const posted: Record<string, unknown>[] = [];
		const listed = [
			{ id: "kept", name: "kept", type: "image" },
			{ id: "draft", name: "draft", type: "image", staged: true },
			{ id: "used", name: "used", type: "image", staged: true },
		];
		globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
			const u = String(url);
			if (/\/media$/.test(u)) return new Response(JSON.stringify(listed));
			if (init?.method === "POST") {
				posted.push(JSON.parse(init.body ?? "{}"));
				return new Response("{}");
			}
			if (init?.method === "PUT") return new Response("{}");
			return new Response(new Blob(["x"]));
		}) as typeof fetch;
		try {
			const storage = new StorageService();
			await storage.saveMediaAsset({ projectId: "p", mediaAsset: asset("new"), staged: true });
			expect(posted.at(-1)).toMatchObject({ id: "new", staged: true });
			const loaded = await storage.loadAllMediaAssets({ projectId: "p", usedIds: new Set(["used"]) });
			expect(loaded.map((a) => a.id).sort()).toEqual(["kept", "used"]);
			await storage.promoteMediaAssets({ projectId: "p", ids: ["draft", "kept"] });
			const promoted = posted.at(-1) as Record<string, unknown>;
			expect(promoted.id).toBe("draft");
			expect("staged" in promoted).toBe(false);
			expect(posted.filter((m) => m.id === "kept")).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("project switches that fail or overlap", () => {
	const withScenes = (editor: ReturnType<typeof EditorCore.getInstance>) => {
		const written: { id: string; scenes: number }[] = [];
		editor.project.persistCurrentProject = async () => {
			const active = editor.project.getActive();
			written.push({ id: active.metadata.id, scenes: editor.scenes.getScenes().length });
			editor.save.recordPersisted({ projectId: active.metadata.id, error: null });
			return null;
		};
		return written;
	};

	test("a project that cannot be read leaves the open one intact, and saving it goes on", async () => {
		const editor = await load(project("a", new Date(0)));
		const written = withScenes(editor);
		stub({ loadProject: async () => { throw new Error("disk gone"); } });
		await expect(editor.project.loadProject({ id: "b" })).rejects.toThrow("disk gone");
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(editor.scenes.getScenes().length).toBe(1);
		editor.save.markDirty();
		await editor.save.flush();
		expect(written.at(-1)).toEqual({ id: "a", scenes: 1 });
		expect(written.every((w) => w.scenes > 0)).toBe(true);
	});

	test("of two overlapping loads, the newest one wins and an older one finishing late changes nothing", async () => {
		const editor = await load(project("a", new Date(0)));
		withScenes(editor);
		let releaseB!: () => void;
		const slowB = new Promise<void>((resolve) => { releaseB = resolve; });
		stub({ loadProject: async ({ id }: { id: string }) => {
			if (id === "b") await slowB;
			return { project: structuredClone(project(id, new Date(0))) };
		} });
		const b = editor.project.loadProject({ id: "b" });
		await wait(5);
		await editor.project.loadProject({ id: "c" });
		releaseB();
		await b;
		expect(editor.project.getActive().metadata.id).toBe("c");
		expect(editor.save.getIsPaused()).toBe(false);
	});

	test("a save of the old project that hangs does not block saving the new one", async () => {
		const editor = await load(project("a", new Date(0)));
		const written: string[] = [];
		let hang = true;
		editor.project.persistCurrentProject = () => {
			const id = editor.project.getActive().metadata.id;
			if (hang) return new Promise(() => {});
			written.push(id);
			editor.save.recordPersisted({ projectId: id, error: null });
			return Promise.resolve(null);
		};
		editor.save.markDirty();
		void editor.save.flush();
		await wait(5);
		stub({ loadProject: async () => ({ project: structuredClone(project("b", new Date(0))) }) });
		// The switch waits for a's save at most a few seconds, then goes on.
		const started = Date.now();
		await editor.project.loadProject({ id: "b" });
		expect(Date.now() - started).toBeLessThan(4500);
		hang = false;
		editor.save.markDirty();
		await editor.save.flush();
		expect(written).toEqual(["b"]);
	}, 10000);
});

describe("staged media through the storage route", () => {
	test("PUT, POST staged metadata, GET listing, then promotion keeps the file and clears the mark", async () => {
		const os = await import("node:os");
		const fs = (await import("node:fs")).promises;
		const path = await import("node:path");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "staged-"));
		const previous = process.env.BOPENCUT_DATA;
		process.env.BOPENCUT_DATA = root;
		try {
			const route = await import("@/app/api/storage/[...slug]/route");
			const call = (method: string, slug: string[], init: RequestInit = {}) =>
				(route as any)[method](new Request(`http://localhost/api/storage/${slug.join("/")}`, { method, ...init }), { params: Promise.resolve({ slug }) }) as Promise<Response>;
			const meta = { id: "m1", name: "logo", type: "image", fileName: "logo.png", fileType: "image/png", size: 3, lastModified: 0 };
			expect((await call("PUT", ["projects", "p", "media", "m1"], { headers: { "x-media-metadata": encodeURIComponent(JSON.stringify({ id: "m1", fileName: "logo.png", fileType: "image/png" })) }, body: new Blob(["png"]) })).status).toBe(200);
			expect((await call("POST", ["projects", "p", "media", "m1"], { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...meta, staged: true }) })).status).toBe(200);
			const listed = await (await call("GET", ["projects", "p", "media"])).json();
			expect(listed).toMatchObject([{ id: "m1", staged: true }]);
			expect((await call("POST", ["projects", "p", "media", "m1"], { headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) })).status).toBe(200);
			const after = await (await call("GET", ["projects", "p", "media"])).json();
			expect(after[0].staged).toBeUndefined();
			expect((await call("GET", ["projects", "p", "media", "m1"])).status).toBe(200);
		} finally {
			if (previous === undefined) delete process.env.BOPENCUT_DATA;
			else process.env.BOPENCUT_DATA = previous;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
