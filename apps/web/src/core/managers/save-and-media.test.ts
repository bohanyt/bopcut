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

/** Renames the main scene: an edit the save manager sees, and visible in what is written. */
function edit(editor: ReturnType<typeof EditorCore.getInstance>, label: string) {
	const scenes = editor.scenes.getScenes().map((scene) => (scene.isMain ? { ...scene, name: label } : scene));
	editor.scenes.setScenes({ scenes, activeSceneId: editor.scenes.getActiveScene().id });
}
const mainName = (stored: TProject) => stored.scenes.find((scene) => scene.isMain)?.name;

/**
 * Storage held in memory: saveProject writes a copy, loadProject reads one. `writes` lists every write
 * in order; the hooks can hold or fail a read, a media load or a write.
 */
function memoryDisk(stored: TProject[]) {
	const files = new Map(stored.map((p) => [p.metadata.id, structuredClone(p)]));
	const writes: { id: string; main: string | undefined; scenes: number }[] = [];
	const hooks: {
		read?: (id: string) => Promise<void> | void;
		media?: (projectId: string) => Promise<void> | void;
		write?: (project: TProject) => Promise<void> | void;
	} = {};
	stub({
		ensureMigrations: async () => {},
		loadProject: async ({ id }: { id: string }) => {
			await hooks.read?.(id);
			const file = files.get(id);
			return file ? { project: structuredClone(file) } : null;
		},
		loadAllMediaAssets: async ({ projectId }: { projectId: string }) => {
			await hooks.media?.(projectId);
			return [];
		},
		saveProject: async ({ project: written }: { project: TProject }) => {
			writes.push({ id: written.metadata.id, main: mainName(written), scenes: written.scenes.length });
			await hooks.write?.(written);
			files.set(written.metadata.id, structuredClone(written));
		},
	});
	return { files, writes, hooks };
}
const gate = () => {
	let open!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
};
/** Resolves once `check` holds, checking every few ms (test helper only). */
async function until(check: () => boolean, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await wait(2);
	}
}

describe("failed saves", () => {
	const dirty = async (failures: number) => {
		const editor = await load(project("p", new Date(0)));
		(editor.save as any).retryDelaysMs = [5, 10];
		const disk = memoryDisk([project("p", new Date(0))]);
		let calls = 0;
		disk.hooks.write = () => {
			calls++;
			if (calls <= failures) throw new Error("EPERM: operation not permitted");
		};
		edit(editor, "edited");
		expect(await editor.save.flush()).toBe(false);
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
		editor.save.retry();
		expect(await editor.save.settle()).toBe(true);
		expect(calls()).toBe(4);
		expect(agentReadiness()).toMatchObject({ ready: true, saveError: null });
	});

	test("settle gives up at its deadline even while a save hangs", async () => {
		const editor = await load(project("p", new Date(0)));
		const disk = memoryDisk([project("p", new Date(0))]);
		disk.hooks.write = () => new Promise(() => {});
		edit(editor, "edited");
		const started = Date.now();
		expect(await editor.save.settle({ timeoutMs: 40 })).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("a save that fails after stop() schedules no retry", async () => {
		const editor = await load(project("p", new Date(0)));
		(editor.save as any).retryDelaysMs = [10];
		const disk = memoryDisk([project("p", new Date(0))]);
		const write = gate();
		disk.hooks.write = () => write.promise;
		edit(editor, "edited");
		const saving = editor.save.flush();
		await wait(5);
		editor.save.stop();
		write.fail(new Error("EPERM: operation not permitted"));
		expect(await saving).toBe(false);
		await wait(40);
		expect(disk.writes.length).toBe(1);
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

describe("save sessions across project switches", () => {
	test("A→B: an edit made just before the switch is written to A, from A's timeline, in the background", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const write = gate();
		disk.hooks.write = (p) => (p.metadata.id === "a" ? write.promise : undefined);
		edit(editor, "a: last edit");
		// The edit is still waiting for its debounce when b opens; the switch does not wait for its write.
		await editor.project.loadProject({ id: "b" });
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(editor.save.hasUnsavedChangesOf("a")).toBe(true);
		expect(editor.save.hasUnsavedChanges()).toBe(true);
		write.open();
		expect(await editor.save.settleProject("a")).toBeNull();
		expect(mainName(disk.files.get("a")!)).toBe("a: last edit");
		// Nothing of a was written as b, and b (not edited) was not written at all.
		expect(disk.writes.filter((w) => w.id === "b")).toEqual([]);
		expect(editor.save.hasUnsavedChanges()).toBe(false);
		// b's own state: nothing pending, ready for the agent.
		expect(agentReadiness()).toMatchObject({ ready: true, pendingSave: false, saveError: null });
	});

	test("A→B→C where C cannot be read: B (still loading its media) stays, finishes, and autosaves", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).debounceMs = 5;
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const media = gate();
		disk.hooks.media = (id) => (id === "b" ? media.promise : undefined);
		const b = editor.project.loadProject({ id: "b" });
		await until(() => editor.project.getActiveOrNull()?.metadata.id === "b");
		await expect(editor.project.loadProject({ id: "c" })).rejects.toThrow("not found");
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(editor.project.getIsLoading()).toBe(true);
		media.open();
		await b;
		expect(editor.project.getIsLoading()).toBe(false);
		expect(editor.save.getCurrent()).toMatchObject({ projectId: "b" });
		expect(editor.save.getCurrent()?.isLoading()).toBe(false);
		edit(editor, "b: edited");
		await until(() => !editor.save.getIsDirty());
		expect(mainName(disk.files.get("b")!)).toBe("b: edited");
		expect(agentReadiness()).toMatchObject({ ready: true });
	});

	test("A→A: reopening the open project writes its unsaved edit first, and the reopened timeline has it", async () => {
		const editor = await load(project("a", new Date(0)));
		memoryDisk([project("a", new Date(0))]);
		edit(editor, "a: unsaved");
		await editor.project.loadProject({ id: "a" });
		expect(mainName({ scenes: editor.scenes.getScenes() } as TProject)).toBe("a: unsaved");
		expect(editor.save.hasUnsavedChanges()).toBe(false);
	});

	test("A→B→A quickly: A opens again only after its background write, and has the edit", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const write = gate();
		disk.hooks.write = (p) => (p.metadata.id === "a" ? write.promise : undefined);
		edit(editor, "a: unsaved");
		await editor.project.loadProject({ id: "b" });
		const reopen = editor.project.loadProject({ id: "a" });
		await wait(10);
		expect(editor.project.getActive().metadata.id).toBe("b"); // waits for a's write
		write.open();
		await reopen;
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(mainName({ scenes: editor.scenes.getScenes() } as TProject)).toBe("a: unsaved");
	});

	test("A's write hangs across the switch: B opens and saves at once; A's later failure is retried from A's snapshot", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).retryDelaysMs = [5];
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const hung = gate();
		let aWrites = 0;
		disk.hooks.write = (p) => (p.metadata.id === "a" && ++aWrites === 1 ? hung.promise : undefined);
		edit(editor, "a: first");
		const firstSave = editor.save.flush();
		await wait(5);
		edit(editor, "a: second"); // after the hung write started
		const started = Date.now();
		await editor.project.loadProject({ id: "b" });
		expect(Date.now() - started).toBeLessThan(500);
		edit(editor, "b: edited");
		expect(await editor.save.flush()).toBe(true);
		expect(mainName(disk.files.get("b")!)).toBe("b: edited");
		// A's hung write fails now: it never counted as saved (b's clean state says nothing about a).
		hung.fail(new Error("EIO: i/o error"));
		expect(await firstSave).toBe(false);
		// Retried from the snapshot taken at the switch, which has a's second edit.
		expect(await editor.save.settleProject("a")).toBeNull();
		expect(mainName(disk.files.get("a")!)).toBe("a: second");
		expect(disk.writes.filter((w) => w.id === "a").every((w) => w.main?.startsWith("a:"))).toBe(true);
		expect(editor.save.getLastError("a")).toBeNull();
	});

	test("a retry due while another project is read writes the first project's full timeline", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).retryDelaysMs = [20];
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		let fail = true;
		disk.hooks.write = () => {
			if (fail) throw new Error("EBUSY: resource busy");
		};
		edit(editor, "a: edited");
		expect(await editor.save.flush()).toBe(false);
		const read = gate();
		disk.hooks.read = (id) => (id === "b" ? read.promise : undefined);
		fail = false;
		const loading = editor.project.loadProject({ id: "b" });
		await wait(60);
		read.open();
		await loading;
		await editor.save.settleProject("a");
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(disk.writes.every((w) => w.scenes > 0)).toBe(true);
		expect(mainName(disk.files.get("a")!)).toBe("a: edited");
	});

	test("while a project loads, only forced edits count, and they are written once the load is done", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).debounceMs = 5;
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const media = gate();
		disk.hooks.media = (id) => (id === "b" ? media.promise : undefined);
		const loading = editor.project.loadProject({ id: "b" });
		await until(() => editor.project.getActiveOrNull()?.metadata.id === "b");
		editor.save.markDirty(); // e.g. scene notifications while opening: not an edit
		expect(editor.save.getIsDirty()).toBe(false);
		await editor.project.updateThumbnail({ thumbnail: "rendered" }); // forced
		await wait(20);
		expect(disk.writes.filter((w) => w.id === "b")).toEqual([]);
		media.open();
		await loading;
		await until(() => !editor.save.getIsDirty());
		expect(disk.files.get("b")!.metadata.thumbnail).toBe("rendered");
	});

	test("of two overlapping loads, the newest one wins and the older one finishing late changes nothing", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0)), project("c", new Date(0))]);
		const slowB = gate();
		disk.hooks.read = (id) => (id === "b" ? slowB.promise : undefined);
		const b = editor.project.loadProject({ id: "b" });
		await wait(5);
		await editor.project.loadProject({ id: "c" });
		slowB.open();
		await b;
		expect(editor.project.getActive().metadata.id).toBe("c");
		expect(editor.project.getIsLoading()).toBe(false);
		expect(editor.save.getCurrent()).toMatchObject({ projectId: "c" });
		expect(editor.save.getCurrent()?.isLoading()).toBe(false);
	});

	test("a project that cannot be read leaves the open one intact, and saving it goes on", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		disk.hooks.read = (id) => {
			if (id === "b") throw new Error("disk gone");
		};
		await expect(editor.project.loadProject({ id: "b" })).rejects.toThrow("disk gone");
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(editor.scenes.getScenes().length).toBe(1);
		edit(editor, "a: after");
		expect(await editor.save.flush()).toBe(true);
		expect(mainName(disk.files.get("a")!)).toBe("a: after");
	});

	test("closing a project writes its unsaved edit; deleting one drops it", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		edit(editor, "a: unsaved");
		editor.project.closeProject();
		expect(await editor.save.settleProject("a")).toBeNull();
		expect(mainName(disk.files.get("a")!)).toBe("a: unsaved");

		await editor.project.loadProject({ id: "a" });
		stub({ deleteProjectMedia: async () => {}, deleteProject: async () => {} });
		const writes = disk.writes.length;
		edit(editor, "a: deleted");
		await editor.project.deleteProjects({ ids: ["a"] });
		await wait(20);
		expect(disk.writes.length).toBe(writes);
		expect(editor.save.hasUnsavedChanges()).toBe(false);
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
