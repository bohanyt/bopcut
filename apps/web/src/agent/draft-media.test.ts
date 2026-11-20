import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
// Asset processing needs browser media APIs: an image is 400×200 whatever its bytes.
mock.module("@/media/processing", () => ({
	processMediaAssets: async ({ files }: { files: File[] }) => Array.from(files).map((file) => ({ name: file.name, type: "image", file, width: 400, height: 200 })),
}));
const { EditorCore } = await import("@/core");
const { applyDraft, pollDraft } = await import("./bridge");
const { storageService } = await import("@/services/storage/service");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const el = (type: string, id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, type, name: id, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(0), params: {}, ...extra }) as unknown as TimelineElement;
const scene = (id: string, tracks: SceneTracks): TScene => ({ id, name: id, isMain: true, tracks, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) });
const asset = (id: string, extra: Partial<MediaAsset> = {}) => ({ id, name: id, type: "image", file: new File(["x"], `${id}.png`, { type: "image/png" }), width: 400, height: 200, ...extra }) as MediaAsset;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = [scene("main", {
		overlay: [{ id: "t-g", name: "Shapes", type: "graphic", hidden: false, elements: [el("graphic", "box", 0, 4, { agentId: "box", definitionId: "line", params: { drawProgress: 1 } })] as any }],
		main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [el("image", "old", 0, 2, { agentId: "old", mediaId: "m-old" })] as VideoElement[] },
		audio: [],
	})];
	editor.project.setActiveProject({
		project: { metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [asset("m-old"), asset("m-new")] });
	return editor;
}
const all = (s: TScene) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((track): TimelineElement[] => track.elements);
const elements = (editor: ReturnType<typeof setup>) => editor.scenes.getScenes().flatMap(all);
const draft = (ops: unknown[], extra: Record<string, unknown> = {}) => ({ schema: "opencut-agent-draft-1", rev: `r${Math.random()}`, ops, ...extra }) as Parameters<typeof applyDraft>[0];
const image = (path: string, agent_id: string) => ({ agent_id, name: agent_id, asset: { path, type: "image", name: agent_id }, start: 0, duration: 1 });
const gate = () => {
	let open!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
	return { promise, open, fail };
};

/**
 * Fake agent file API and storage. `slow` paths wait for their gate, `missing` paths 404.
 * Storage records saved and deleted media ids; `failSave`/`failDelete` make those calls throw.
 */
function fakeBackend({ slow = new Map<string, Promise<void>>(), missing = new Set<string>(), failSave = new Set<string>(), failDelete = false, slowDelete = Promise.resolve() } = {}) {
	const state = { saved: [] as string[], deleted: [] as string[], promoted: [] as string[], results: [] as any[], fileNames: new Map<string, string>() };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: { body?: string }) => {
		const u = String(url);
		if (u.startsWith("/api/agent/file")) {
			const path = decodeURIComponent(u.split("p=")[1]);
			await slow.get(path);
			return missing.has(path) ? new Response(null, { status: 404 }) : new Response(new Blob(["png"], { type: "image/png" }));
		}
		if (u === "/api/agent/applied") state.results.push(JSON.parse(init?.body ?? "{}"));
		return new Response("{}");
	}) as typeof fetch;
	const stubs = {
		promoteMediaAssets: async ({ ids }: { ids: string[] }) => {
			state.promoted.push(...ids);
		},
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			state.saved.push(mediaAsset.id);
			state.fileNames.set(mediaAsset.id, mediaAsset.file.name);
			// e.g. the file PUT succeeded, the metadata POST hit EPERM
			if (failSave.has(mediaAsset.file.name)) throw new Error("EPERM: operation not permitted, rename");
		},
		deleteMediaAsset: async ({ id }: { id: string }) => {
			await slowDelete;
			if (failDelete) throw new Error("EBUSY: resource busy");
			state.deleted.push(id);
		},
	};
	Object.assign(storageService, stubs);
	return {
		state,
		restore: () => {
			globalThis.fetch = realFetch;
			for (const key of Object.keys(stubs)) delete (storageService as any)[key];
		},
	};
}

/**
 * Project writes to storage: records each write's project id and agent ids; `fail` returns an error to
 * throw for a project, `wait` a promise the write waits for (or that rejects).
 */
function projectWrites({ fail, wait }: { fail?: (id: string) => string | null; wait?: (id: string) => Promise<void> | undefined } = {}) {
	const writes: { id: string; agentIds: string[] }[] = [];
	(storageService as any).saveProject = async ({ project }: { project: TProject }) => {
		const id = project.metadata.id;
		writes.push({ id, agentIds: project.scenes.flatMap(all).flatMap((e) => (e.agentId ? [e.agentId] : [])) });
		await wait?.(id);
		const error = fail?.(id);
		if (error) throw new Error(error);
	};
	return { writes, restore: () => delete (storageService as any).saveProject };
}

let restore = () => {};
afterEach(() => {
	restore();
	restore = () => {};
	EditorCore.reset();
});

describe("draft imports stay private until commit", () => {
	test("a failing draft's rollback never deletes media another edit already uses", async () => {
		const editor = setup();
		const slowBad = gate();
		const backend = fakeBackend({ slow: new Map([["bad.png", slowBad.promise]]), missing: new Set(["bad.png"]) });
		restore = backend.restore;
		// Draft A imports ok.png, then waits on bad.png (which will fail).
		const a = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("ok.png", "a-ok") }, { op: "add", track: { name: "Logos" }, element: image("bad.png", "a-bad") }]));
		while (backend.state.saved.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		const importedId = backend.state.saved[0];
		// Meanwhile someone (a human, or a direct applyDraft call) uses that media.
		const visible = editor.media.getAssets().some((m) => m.id === importedId);
		const b = applyDraft(draft([{ op: "add", track: { name: "Clips" }, element: { agent_id: "b", name: "B", mediaId: importedId, start: 3, duration: 1 } }]));
		await new Promise((resolve) => setTimeout(resolve, 5));
		slowBad.open();
		await Promise.all([a, b]);

		expect(visible).toBe(false);
		expect(backend.state.deleted).toEqual([importedId]);
		// No clip anywhere points at media that was deleted or is not in the project.
		const known = new Set(editor.media.getAssets().map((m) => m.id));
		for (const e of elements(editor) as any[]) if (e.mediaId) {
			expect(backend.state.deleted).not.toContain(e.mediaId);
			expect(known.has(e.mediaId)).toBe(true);
		}
		const [resultA, resultB] = backend.state.results;
		expect(resultA).toMatchObject({ applied: false, rolledBack: true, cleanup: { removed: [importedId], failed: [] } });
		expect(resultB.applied).toBe(false);
		expect(resultB.results[0].error).toContain(importedId);
	});

	test("drafts run one at a time, also when applyDraft is called directly", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const order: string[] = [];
		const a = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "first") }])).then(() => order.push("first"));
		const b = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("fast.png", "second") }])).then(() => order.push("second"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The second draft has not even started importing while the first one waits.
		expect(backend.state.saved.length).toBe(0);
		slow.open();
		await Promise.all([a, b]);
		expect(order).toEqual(["first", "second"]);
		expect(elements(editor).filter((e) => e.agentId === "first" || e.agentId === "second").length).toBe(2);
	});

	test("committed imports are published; ones only used by failed ops are removed", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("used.png", "used") },
			{ op: "add", track: { name: "Logos" }, element: { ...image("unused.png", "unused"), text: undefined, effect: undefined, model3d: {} } },
		]));
		const result = backend.state.results.at(-1);
		expect(result.results.map((r: any) => r.ok)).toEqual([true, false]);
		const used = (elements(editor).find((e) => e.agentId === "used") as any).mediaId;
		expect(editor.media.getAssets().some((m) => m.id === used)).toBe(true);
		const unusedId = backend.state.saved.find((id) => id !== used)!;
		expect(backend.state.deleted).toEqual([unusedId]);
		expect(editor.media.getAssets().some((m) => m.id === unusedId)).toBe(false);
		// Published media is never deleted by a discard.
		expect(await editor.media.discardStagedMediaAssets({ ids: [used] })).toEqual({ removed: [], failed: [{ id: used, error: "published; kept" }] });
	});
});

describe("failed imports are cleaned up and reported", () => {
	test("a save that fails after writing the file (metadata EPERM) deletes the partial file", async () => {
		const editor = setup();
		const before = JSON.stringify(editor.scenes.getScenes());
		const backend = fakeBackend({ failSave: new Set(["half.png"]) });
		restore = backend.restore;
		await applyDraft(draft([{ op: "delete", match: { agentId: "old" } }, { op: "add", track: { name: "Logos" }, element: image("half.png", "half") }]));
		const result = backend.state.results.at(-1);
		expect(backend.state.saved.length).toBe(1);
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(result).toMatchObject({ applied: false, rolledBack: true });
		expect(result.results[1].error).toContain("EPERM");
		expect(JSON.stringify(editor.scenes.getScenes())).toBe(before);
	});

	test("cleanup failures are reported instead of claiming a full rollback", async () => {
		setup();
		const backend = fakeBackend({ missing: new Set(["gone.png"]), failDelete: true });
		restore = backend.restore;
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("ok.png", "ok") }, { op: "add", track: { name: "Logos" }, element: image("gone.png", "gone") }]));
		const result = backend.state.results.at(-1);
		expect(result.applied).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.cleanup.failed).toEqual([{ id: backend.state.saved[0], error: "EBUSY: resource busy" }]);
		expect(result.error).toContain("1 imported file could not be removed");
	});
});

describe("replace with direct media", () => {
	test("replace by mediaId uses the preloaded media", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "replace", match: { agentId: "old" }, element: { mediaId: "m-new" } }]));
		const result = backend.state.results.at(-1);
		expect(result.results[0].ok).toBe(true);
		const replaced = elements(editor).find((e) => e.agentId === "old") as any;
		expect(replaced.mediaId).toBe("m-new");
		expect(replaced.id).not.toBe("old");
	});

	test("replace by asset uses the imported media", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "replace", match: { agentId: "old" }, element: { asset: { path: "logo.png", type: "image", name: "Logo" }, duration: 3 } }]));
		const result = backend.state.results.at(-1);
		expect(result.results[0].ok).toBe(true);
		const replaced = elements(editor).find((e) => e.agentId === "old") as any;
		expect(replaced.mediaId).toBe(backend.state.saved[0]);
		expect(replaced.duration).toBe(T(3));
		expect(editor.media.getAssets().some((m) => m.id === backend.state.saved[0])).toBe(true);
	});
});

describe("keyframe values", () => {
	const keys = (editor: ReturnType<typeof setup>) => (elements(editor).find((e) => e.agentId === "box")?.animations as any)?.opacity?.keys?.length ?? 0;
	test("replace with an invalid value fails the op and keeps the existing keyframes", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframes: [{ path: "opacity", time: 0, value: 0 }, { path: "opacity", time: 1, value: 1 }] }]));
		expect(keys(editor)).toBe(2);
		for (const extra of [{}, { atomic: true }]) {
			await applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframesMode: "replace", keyframes: [{ path: "opacity", time: 0, value: "not a number" }] }], extra));
			const result = backend.state.results.at(-1);
			expect(result.results[0].ok).toBe(false);
			expect(result.results[0].error).toContain("invalid value for opacity");
			expect(keys(editor)).toBe(2);
		}
	});
});

describe("drafts belong to the project session they were queued in", () => {
	const otherProject = (editor: ReturnType<typeof setup>) => {
		const scenes = [scene("main-q", { overlay: [], main: { id: "t-q", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] })];
		editor.project.setActiveProject({
			project: { metadata: { id: "q", name: "q", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main-q", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject,
		});
		editor.scenes.setScenes({ scenes, activeSceneId: "main-q" });
	};

	test("opening another project while a draft loads or waits: nothing applies there, imports are removed", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const first = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "first") }]));
		const second = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("fast.png", "second") }]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		otherProject(editor);
		slow.open();
		await Promise.all([first, second]);
		expect(elements(editor).map((e) => e.agentId).filter(Boolean)).toEqual([]);
		const [a, b] = backend.state.results;
		expect(a).toMatchObject({ projectId: "p", applied: false, rolledBack: true });
		expect(a.error).toContain("another project");
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(b).toMatchObject({ projectId: "p", applied: false });
		expect(b.error).toContain("another project");
		// The waiting draft never imported anything.
		expect(backend.state.saved.length).toBe(1);
	});

	test("a draft for another projectId is refused", async () => {
		setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("a.png", "a") }], { projectId: "zzz" }));
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(backend.state.results[0].error).toContain("not the open one");
		expect(backend.state.saved).toEqual([]);
	});

	test("reused media deleted while assets load stop the draft", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: { agent_id: "reuse", name: "reuse", mediaId: "m-new", start: 0, duration: 1 } },
			{ op: "add", track: { name: "Logos" }, element: image("slow.png", "slow") },
		]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		editor.media.setAssets({ assets: [asset("m-old")] });
		slow.open();
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(backend.state.results[0].error).toContain("m-new");
		expect(elements(editor).some((e) => e.agentId === "reuse" || e.agentId === "slow")).toBe(false);
		expect(backend.state.deleted).toEqual(backend.state.saved);
	});

	test("committed imports are promoted on disk once a write containing them is saved, also a later one", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const disk = projectWrites();
		restore = () => {
			backend.restore();
			disk.restore();
		};
		// Saving is off (setup): the commit is not on disk, so nothing is promoted.
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "saving is off" });
		expect(backend.state.promoted).toEqual([]);
		// Saving works: the next write contains both drafts, so both imports are promoted.
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("second.png", "second") }]));
		expect(backend.state.results[1]).toMatchObject({ applied: true, saved: true });
		expect([...backend.state.promoted].sort()).toEqual([...backend.state.saved].sort());
	});

	test("the draft's write fails, another project opens, the background retry lands: its imports are promoted then", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		const backend = fakeBackend();
		const disk = projectWrites({ fail: (id) => (id === "p" && failing ? "EIO: i/o error" : null) });
		let failing = true;
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "EIO: i/o error" });
		expect(backend.state.promoted).toEqual([]);
		failing = false;
		otherProject(editor);
		expect(await editor.save.settleProject("p")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(backend.state.promoted).toEqual(backend.state.saved);
		// p was written from its own timeline (with the draft's clip), never q's.
		expect(disk.writes.filter((w) => w.id === "p").at(-1)?.agentIds).toContain("first");
		expect(disk.writes.filter((w) => w.id === "q").every((w) => !w.agentIds.includes("first"))).toBe(true);
	});

	test("a draft undone before its first successful write: the retry saves without it, and its import stays staged", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		let failing = true;
		const backend = fakeBackend();
		const disk = projectWrites({ fail: (id) => (id === "p" && failing ? "EIO: i/o error" : null) });
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false });
		editor.command.undo();
		expect(elements(editor).some((e) => e.agentId === "first")).toBe(false);
		failing = false;
		expect(await editor.save.settle()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(disk.writes.at(-1)?.agentIds).not.toContain("first");
		expect(backend.state.promoted).toEqual([]);
	});

	test("a write that lands while the draft's unused imports are still being removed still promotes the used ones", async () => {
		const editor = setup();
		const removal = gate();
		const backend = fakeBackend({ slowDelete: removal.promise });
		const disk = projectWrites();
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		const run = applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("used.png", "used") },
			// Fails after its asset was imported: that import is unused and removed (slowly).
			{ op: "replace", match: { agentId: "nope" }, element: image("unused.png", "unused") },
		]));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The project closes while the removal runs: its background write has the draft.
		otherProject(editor);
		expect(await editor.save.settleProject("p")).toBeNull();
		removal.open();
		await run;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const used = backend.state.fileNames;
		const usedId = [...used.entries()].find(([, name]) => name.includes("used") && !name.includes("unused"))?.[0];
		expect(usedId).toBeDefined();
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: true });
		expect(backend.state.promoted).toEqual([usedId as string]);
	});

	test("the draft's write hangs while another project opens and saves: the draft is not reported saved", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		const backend = fakeBackend();
		const hung = gate();
		let pWrites = 0;
		const disk = projectWrites({ wait: (id) => (id === "p" && ++pWrites === 1 ? hung.promise : undefined) });
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		otherProject(editor);
		// q saves at once and is clean: that says nothing about p.
		expect(await editor.save.flush()).toBe(true);
		hung.fail(new Error("EIO: i/o error"));
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "EIO: i/o error" });
		expect(backend.state.promoted).toEqual([]);
		// The retry from p's snapshot lands, and the import is promoted then.
		expect(await editor.save.settleProject("p")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(backend.state.promoted).toEqual(backend.state.saved);
	});
});

describe("malformed element trees", () => {
	test("a null element inside a compound fails its op before anything is imported, and a result is written", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("ok.png", "ok") },
			{ op: "compound", name: "Broken", elements: [null] },
		]));
		const [result] = backend.state.results;
		expect(result).toMatchObject({ applied: false, rolledBack: true });
		expect(result.results[1].error).toContain("not an object");
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(elements(editor).some((e) => e.agentId === "ok")).toBe(false);
	});
});

describe("the draft poller", () => {
	test("a project opened while draft.json is read: the draft is left for the next poll, not applied or refused", async () => {
		const editor = setup();
		const store = new Map<string, string>();
		const previousStorage = (globalThis as any).localStorage;
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
		const backend = fakeBackend();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: unknown) => {
			if (String(url) === "/api/agent/draft") {
				// The human opens another project while the poll waits for the file.
				const scenes = [scene("main-q", { overlay: [], main: { id: "t-q", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] })];
				editor.project.setActiveProject({ project: { metadata: { id: "q", name: "q", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main-q", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject });
				editor.scenes.setScenes({ scenes, activeSceneId: "main-q" });
				return new Response(JSON.stringify(draft([{ op: "delete", match: { agentId: "old" } }])));
			}
			return realFetch(url as never, init as never);
		}) as typeof fetch;
		// The open project is ready: loaded, its media loaded, nothing to save.
		(editor.project as any).isLoading = false;
		(editor.media as any).loadedProjectId = "p";
		(editor.media as any).isLoading = false;
		try {
			const { agentReadiness } = await import("./bridge");
			expect(agentReadiness().ready).toBe(true);
			await pollDraft();
		} finally {
			globalThis.fetch = realFetch;
			backend.restore();
			(globalThis as any).localStorage = previousStorage;
		}
		expect(backend.state.results).toEqual([]);
		expect([...store.keys()]).toEqual([]);
		expect(editor.project.getActive().metadata.id).toBe("q");
	});
});
