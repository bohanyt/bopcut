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
		rename?: (id: string) => Promise<void> | void;
	} = {};
	stub({
		ensureMigrations: async () => {},
		loadProject: async ({ id }: { id: string }) => {
			// What a slow read returns is the file as it was when the read started.
			const file = files.get(id);
			const copy = file ? structuredClone(file) : null;
			await hooks.read?.(id);
			return copy ? { project: copy } : null;
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
		// Applied to the stored copy at the moment it is written (see DiskAdapter.update).
		renameProject: async ({ id, name }: { id: string; name: string }) => {
			await hooks.rename?.(id);
			const file = files.get(id);
			if (!file) return null;
			file.metadata = { ...file.metadata, name, updatedAt: new Date() };
			return file.metadata;
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
		const disk = memoryDisk([project("a", new Date(0))]);
		let reads = 0;
		disk.hooks.read = () => {
			reads++;
		};
		edit(editor, "a: unsaved");
		await editor.project.loadProject({ id: "a" });
		expect(mainName({ scenes: editor.scenes.getScenes() } as TProject)).toBe("a: unsaved");
		expect(editor.save.hasUnsavedChanges()).toBe(false);
		// The edit was on disk before the read started: read once, not again.
		expect(reads).toBe(1);
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
		// The retry ran while b was being read, from a's full timeline.
		expect(mainName(disk.files.get("a")!)).toBe("a: edited");
		expect(editor.save.hasUnsavedChangesOf("a")).toBe(false);
		read.open();
		await loading;
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(disk.writes.every((w) => w.scenes > 0)).toBe(true);
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

describe("save sessions: reads, renames, deletes and the page guard", () => {
	test("A→A where A is edited and saved while it is read: the stale read is not installed", async () => {
		const editor = await load(project("a", new Date(0)));
		(editor.save as any).debounceMs = 1;
		const disk = memoryDisk([project("a", new Date(0))]);
		const read = gate();
		let reads = 0;
		disk.hooks.read = () => (++reads === 1 ? read.promise : undefined);
		const reopen = editor.project.loadProject({ id: "a" });
		await wait(5);
		edit(editor, "a: edited during the read");
		await until(() => !editor.save.getIsDirty());
		expect(mainName(disk.files.get("a")!)).toBe("a: edited during the read");
		read.open(); // returns the copy from before the edit
		await reopen;
		expect(reads).toBe(2);
		expect(mainName({ scenes: editor.scenes.getScenes() } as TProject)).toBe("a: edited during the read");
		expect(mainName(disk.files.get("a")!)).toBe("a: edited during the read");
	});

	test("renaming a project closed a moment ago waits for its last write, and keeps both", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		const write = gate();
		let aWrites = 0;
		disk.hooks.write = () => (++aWrites === 1 ? write.promise : undefined);
		edit(editor, "a: unsaved");
		editor.project.closeProject();
		const rename = editor.project.renameProject({ id: "a", name: "renamed" });
		await wait(10);
		expect(disk.files.get("a")!.metadata.name).toBe("a");
		write.open();
		await rename;
		expect(disk.files.get("a")!.metadata.name).toBe("renamed");
		expect(mainName(disk.files.get("a")!)).toBe("a: unsaved");
	});

	test("renaming the open project renames it in the editor and saves it with its newer timeline", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		edit(editor, "a: unsaved");
		await editor.project.renameProject({ id: "a", name: "renamed" });
		expect(editor.project.getActive().metadata.name).toBe("renamed");
		expect(disk.files.get("a")!.metadata.name).toBe("renamed");
		expect(mainName(disk.files.get("a")!)).toBe("a: unsaved");
	});

	test("delete waits for a write in progress and nothing is written after it", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		const write = gate();
		disk.hooks.write = () => write.promise;
		let deletedAt = -1;
		stub({ deleteProjectMedia: async () => {}, deleteProject: async () => { deletedAt = disk.writes.length; } });
		edit(editor, "a: saving");
		void editor.save.flush();
		await wait(5);
		const deleting = editor.project.deleteProjects({ ids: ["a"] });
		await wait(10);
		expect(deletedAt).toBe(-1); // still waiting for the write
		edit(editor, "a: after the delete started");
		write.open();
		await deleting;
		expect(deletedAt).toBe(1);
		await wait(20);
		expect(disk.writes.length).toBe(1);
		expect(editor.save.hasUnsavedChanges()).toBe(false);
	});

	test("a delete that fails leaves the project saving as before", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		stub({ deleteProjectMedia: async () => {}, deleteProject: async () => { throw new Error("EBUSY"); } });
		edit(editor, "a: kept");
		await editor.project.deleteProjects({ ids: ["a"] });
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(editor.save.getIsDirty()).toBe(true);
		expect(await editor.save.flush()).toBe(true);
		expect(mainName(disk.files.get("a")!)).toBe("a: kept");
	});

	test("a write that hits a conflict after the project was deleted does not bring it back", async () => {
		const { DiskAdapter } = await import("@/services/storage/disk-adapter");
		const adapter = new DiskAdapter();
		(adapter as any).revisions.set("gone", "r1");
		const puts: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
			if (init?.method === "PUT") {
				puts.push(init.headers?.["If-Match"] ?? "");
				return new Response("conflict", { status: 409 });
			}
			return new Response("missing", { status: 404 });
		}) as typeof fetch;
		try {
			await expect(adapter.set({ key: "gone", value: project("gone", new Date(0)) as any })).rejects.toThrow("deleted");
			// The save session's retry: still not created again.
			await expect(adapter.set({ key: "gone", value: project("gone", new Date(0)) as any })).rejects.toThrow("deleted");
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(puts).toEqual(["r1"]);
	});

	test("closing the editor while another project is read: it does not open after the close", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const read = gate();
		disk.hooks.read = (id) => (id === "b" ? read.promise : undefined);
		const loading = editor.project.loadProject({ id: "b" });
		await wait(5);
		editor.project.closeProject();
		read.open();
		await loading;
		expect(editor.project.getActiveOrNull()).toBeNull();
		expect(editor.project.getIsLoading()).toBe(false);
	});

	test("a load replaced while it loads media stops there: no thumbnail is rendered into the next project", async () => {
		const editor = await load(project("a", new Date(0)));
		const noThumbnail = { ...project("b", new Date(0)), metadata: { ...project("b", new Date(0)).metadata, thumbnail: undefined } } as TProject;
		const disk = memoryDisk([project("a", new Date(0)), noThumbnail, project("c", new Date(0))]);
		const media = gate();
		disk.hooks.media = (id) => (id === "b" ? media.promise : undefined);
		let renders = 0;
		(editor.project as any).updateThumbnailFromTimeline = async () => {
			renders++;
			return false;
		};
		const b = editor.project.loadProject({ id: "b" });
		await until(() => editor.project.getActiveOrNull()?.metadata.id === "b");
		await editor.project.loadProject({ id: "c" });
		media.open();
		await b;
		expect(renders).toBe(0);
		expect(editor.project.getActive().metadata.id).toBe("c");
		expect(disk.files.get("c")!.metadata.thumbnail).toBe("t");
	});

	test("a new project is not ready for the agent until its first write is done", async () => {
		const editor = EditorCore.getInstance();
		(editor.project as any).isLoading = false; // no load runs in this test: only the session decides
		const write = gate();
		stub({ saveProject: () => write.promise });
		const creating = editor.project.createNewProject({ name: "new" });
		await wait(5);
		expect(agentReadiness()).toMatchObject({ ready: false, mediaLoaded: true, pendingSave: false });
		write.open();
		await creating;
		expect(agentReadiness().ready).toBe(true);
	});

	test("settles that time out on a hung write leave no waiters behind", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		disk.hooks.write = () => new Promise(() => {});
		edit(editor, "a: hung");
		for (let i = 0; i < 3; i++) expect(await editor.save.settle({ timeoutMs: 5 })).toBe(false);
		const session = editor.save.getCurrent() as any;
		expect(session.savedWaiters.length).toBe(0);
		expect(session.failureWaiters.size).toBe(0);
	});

	test("the page asks before it is left while any project has unsaved changes, also after its editor closed", async () => {
		const listeners = new Set<(event: any) => void>();
		const previous = (globalThis as any).window;
		(globalThis as any).window = {
			addEventListener: (type: string, listener: (event: any) => void) => type === "beforeunload" && listeners.add(listener),
			removeEventListener: (type: string, listener: (event: any) => void) => type === "beforeunload" && listeners.delete(listener),
		};
		try {
			const editor = await load(project("a", new Date(0)));
			const disk = memoryDisk([project("a", new Date(0))]);
			const write = gate();
			disk.hooks.write = () => write.promise;
			expect(listeners.size).toBe(0);
			edit(editor, "a: unsaved");
			expect(listeners.size).toBe(1);
			editor.project.closeProject();
			let prevented = false;
			for (const listener of listeners) listener({ preventDefault: () => { prevented = true; } });
			expect(prevented).toBe(true);
			write.open();
			expect(await editor.save.settleProject("a")).toBeNull();
			expect(listeners.size).toBe(0);
		} finally {
			EditorCore.reset();
			if (previous === undefined) delete (globalThis as any).window;
			else (globalThis as any).window = previous;
		}
	});
});

describe("save sessions: concurrent deletes, renames and creates", () => {
	test("a batch delete where one project fails: the deleted one stays deleted, the other keeps its media and saving", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const mediaDeleted: string[] = [];
		stub({
			deleteProject: async ({ id }: { id: string }) => {
				if (id === "a") throw new Error("EBUSY");
				disk.files.delete(id);
			},
			deleteProjectMedia: async ({ projectId }: { projectId: string }) => {
				mediaDeleted.push(projectId);
			},
		});
		edit(editor, "a: kept");
		await editor.project.deleteProjects({ ids: ["a", "b"] });
		// The storage delete of a project removes its media too: nothing else is deleted.
		expect(mediaDeleted).toEqual([]);
		expect(disk.files.has("b")).toBe(false);
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(await editor.save.flush()).toBe(true);
		expect(mainName(disk.files.get("a")!)).toBe("a: kept");
		expect(disk.writes.some((w) => w.id === "b")).toBe(false);
	});

	test("a project read while it is deleted does not open afterwards", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		stub({ deleteProject: async ({ id }: { id: string }) => { disk.files.delete(id); }, deleteProjectMedia: async () => {} });
		const read = gate();
		disk.hooks.read = (id) => (id === "b" ? read.promise : undefined);
		const opening = editor.project.loadProject({ id: "b" });
		await wait(5);
		await editor.project.deleteProjects({ ids: ["b"] });
		read.open(); // returns the copy read before the delete
		await expect(opening).rejects.toThrow("not found");
		expect(editor.project.getActive().metadata.id).toBe("a");
		expect(disk.writes.some((w) => w.id === "b")).toBe(false);
	});

	test("deleting the open project does not cancel another project that is opening", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		stub({ deleteProject: async ({ id }: { id: string }) => { disk.files.delete(id); }, deleteProjectMedia: async () => {} });
		const read = gate();
		disk.hooks.read = (id) => (id === "b" ? read.promise : undefined);
		const opening = editor.project.loadProject({ id: "b" });
		await wait(5);
		await editor.project.deleteProjects({ ids: ["a"] });
		expect(editor.project.getActiveOrNull()).toBeNull();
		read.open();
		await opening;
		expect(editor.project.getActive().metadata.id).toBe("b");
		expect(editor.project.getIsLoading()).toBe(false);
	});

	test("a new project whose first write fails counts as unsaved (not ready) and is retried", async () => {
		const editor = EditorCore.getInstance();
		(editor.project as any).isLoading = false;
		(editor.save as any).retryDelaysMs = [5];
		let fail = true;
		let written = 0;
		stub({ saveProject: async () => {
			if (fail) throw new Error("EIO");
			written++;
		} });
		await expect(editor.project.createNewProject({ name: "new" })).rejects.toThrow("EIO");
		expect(agentReadiness()).toMatchObject({ ready: false, pendingSave: true });
		fail = false;
		await until(() => !editor.save.getIsDirty());
		expect(written).toBeGreaterThan(0);
		expect(agentReadiness().ready).toBe(true);
	});

	test("the rename of a stored project is applied to the copy on disk when it is written", async () => {
		const { DiskAdapter } = await import("@/services/storage/disk-adapter");
		const adapter = new DiskAdapter();
		const stored = (scenes: string) => ({ ...project("r", new Date(0)), scenes: [{ ...project("r", new Date(0)).scenes[0], name: scenes }] });
		let version = 1;
		const bodies: any[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
			if (init?.method === "PUT") {
				bodies.push(JSON.parse(init.body ?? "{}"));
				// Another write lands between the first read and the first write.
				if (init.headers?.["If-Match"] === "r1") {
					version = 2;
					return new Response("conflict", { status: 409 });
				}
				return new Response("{}", { status: 200, headers: { etag: "r3" } });
			}
			return new Response(JSON.stringify(stored(version === 1 ? "old timeline" : "newer timeline")), { status: 200, headers: { etag: `r${version}` } });
		}) as typeof fetch;
		try {
			const renamed = await adapter.update("r", (value) => ({ ...value, metadata: { ...value.metadata, name: "renamed" } }));
			expect(renamed?.metadata.name).toBe("renamed");
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(bodies.length).toBe(2);
		expect(bodies[1].metadata.name).toBe("renamed");
		expect(bodies[1].scenes[0].name).toBe("newer timeline");
	});

	test("closing a project while its latest edit is being written reuses that write's project", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		const write = gate();
		disk.hooks.write = () => write.promise;
		edit(editor, "a: saving");
		void editor.save.flush();
		await wait(5);
		let snapshots = 0;
		const real = editor.project.snapshotActive.bind(editor.project);
		editor.project.snapshotActive = () => {
			snapshots++;
			return real();
		};
		editor.project.closeProject();
		expect(snapshots).toBe(0);
		write.open();
		expect(await editor.save.settleProject("a")).toBeNull();
		expect(mainName(disk.files.get("a")!)).toBe("a: saving");
	});
});

describe("save sessions: storage edge cases", () => {
	test("a rename writes with the revision of the copy it changed, even if the shared cache moved on", async () => {
		const { DiskAdapter } = await import("@/services/storage/disk-adapter");
		for (const moved of ["r2", null]) {
			const adapter = new DiskAdapter();
			const ifMatch: string[] = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
				if (init?.method === "PUT") {
					ifMatch.push(init.headers?.["If-Match"] ?? "");
					return new Response("conflict", { status: 409 });
				}
				return new Response(JSON.stringify(project("r", new Date(0))), { status: 200, headers: { etag: "r1" } });
			}) as typeof fetch;
			try {
				await expect(adapter.update("r", (value) => {
					// Another read (an open, a duplicate) refreshed the cache, or saw the project gone.
					if (moved) (adapter as any).revisions.set("r", moved);
					else (adapter as any).revisions.delete("r");
					return { ...value, metadata: { ...value.metadata, name: "renamed" } };
				})).rejects.toThrow("kept changing");
			} finally {
				globalThis.fetch = realFetch;
			}
			expect(ifMatch.length).toBe(5);
			expect(ifMatch.every((revision) => revision === "r1")).toBe(true);
		}
	});

	test("the storage delete moves a project out in one step, then removes it", async () => {
		const os = await import("node:os");
		const fs = (await import("node:fs")).promises;
		const path = await import("node:path");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "delete-"));
		const previous = process.env.BOPENCUT_DATA;
		process.env.BOPENCUT_DATA = root;
		try {
			const route = await import("@/app/api/storage/[...slug]/route");
			const call = (method: string, slug: string[], init: RequestInit = {}) =>
				(route as any)[method](new Request(`http://localhost/api/storage/${slug.join("/")}`, { method, ...init }), { params: Promise.resolve({ slug }) }) as Promise<Response>;
			const stored = { ...project("d", new Date(0)), metadata: { ...project("d", new Date(0)).metadata, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } };
			expect((await call("PUT", ["projects", "d"], { headers: { "Content-Type": "application/json", "If-Match": "new" }, body: JSON.stringify(stored) })).status).toBe(200);
			await fs.mkdir(path.join(root, "projects", "d", "media"), { recursive: true });
			await fs.writeFile(path.join(root, "projects", "d", "media", "m.bin"), "x");
			expect((await call("DELETE", ["projects", "d"])).status).toBe(200);
			expect((await call("GET", ["projects", "d"])).status).toBe(404);
			expect(await fs.readdir(path.join(root, "projects"))).toEqual([]);
			expect(await fs.readdir(path.join(root, "trash"))).toEqual([]);
			// Deleting it again is fine.
			expect((await call("DELETE", ["projects", "d"])).status).toBe(200);
		} finally {
			if (previous === undefined) delete process.env.BOPENCUT_DATA;
			else process.env.BOPENCUT_DATA = previous;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("opening a project while its rename is written waits for it, and keeps the new name", async () => {
		const editor = await load(project("b", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const rename = gate();
		disk.hooks.rename = () => rename.promise;
		const renaming = editor.project.renameProject({ id: "a", name: "renamed" });
		await wait(5);
		const opening = editor.project.loadProject({ id: "a" });
		await wait(10);
		expect(editor.project.getActive().metadata.id).toBe("b");
		rename.open();
		await Promise.all([renaming, opening]);
		expect(editor.project.getActive().metadata.name).toBe("renamed");
		edit(editor, "a: edited");
		editor.project.closeProject();
		expect(await editor.save.settleProject("a")).toBeNull();
		expect(disk.files.get("a")!.metadata.name).toBe("renamed");
	});

	test("opening a project while it is being deleted says so (not \"not found\", which would start a new project)", async () => {
		const editor = await load(project("b", new Date(0)));
		memoryDisk([project("a", new Date(0)), project("b", new Date(0))]);
		const deleting = gate();
		stub({ deleteProject: () => deleting.promise, deleteProjectMedia: async () => {} });
		const removal = editor.project.deleteProjects({ ids: ["a"] });
		await wait(5);
		await expect(editor.project.loadProject({ id: "a" })).rejects.toThrow("being deleted");
		deleting.fail(new Error("EBUSY"));
		await removal;
		// The delete failed: the project opens again.
		await editor.project.loadProject({ id: "a" });
		expect(editor.project.getActive().metadata.id).toBe("a");
	});

	test("leaving the editor does not wait for a save in progress", async () => {
		const editor = await load(project("a", new Date(0)));
		const disk = memoryDisk([project("a", new Date(0))]);
		disk.hooks.write = () => new Promise(() => {});
		(editor.project as any).updateThumbnailFromTimeline = async () => {
			await editor.project.updateThumbnail({ thumbnail: "exit" });
			return true;
		};
		edit(editor, "a: saving");
		void editor.save.flush();
		await wait(5);
		const started = Date.now();
		await editor.project.prepareExit();
		editor.project.closeProject();
		expect(Date.now() - started).toBeLessThan(200);
		expect(editor.save.hasUnsavedChangesOf("a")).toBe(true);
	});
});
