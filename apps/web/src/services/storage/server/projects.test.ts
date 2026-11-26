import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET, HEAD, POST, PUT, DELETE } from "../../../app/api/storage/[...slug]/route";
import { StorageService } from "../service";
import { IndexedDBAdapter } from "../indexeddb-adapter";
import { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, scene, t, text } from "@/timeline/__tests__/compound-fixtures";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "project-persistence-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});

const base = "/api/storage/projects";
function route(method: "GET" | "PUT" | "DELETE", id = "", suffix = "", init: RequestInit = {}) {
	const slug = ["projects", ...[id, suffix].filter(Boolean)];
	const url = `http://localhost/api/storage/${slug.join("/")}`;
	const handlers = { GET, PUT, DELETE };
	return handlers[method](new Request(url, { ...init, method }), { params: Promise.resolve({ slug }) });
}
const projectPath = (id: string, file = "project.json") => path.join(root, "projects", id, file);
const fixture = (id: string, version = 31) => ({
	metadata: { id, name: id, duration: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
	version,
	currentSceneId: "main",
	scenes: [],
});
async function writeLegacy<T extends { metadata: { id: string } }>(project: T) {
	const file = projectPath(project.metadata.id);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(project));
}

test("lists compact summaries for legacy projects and reflects rename and delete", async () => {
	const id = "legacy-summary";
	const stored = {
		...fixture(id),
		scenes: [{ id: "main", tracks: { main: { elements: Array.from({ length: 500 }, () => ({ text: "caption".repeat(50) })) } } }],
	};
	await writeLegacy(stored);
	const body = await (await route("GET")).text();
	expect(body.length).toBeLessThan(1024);
	expect(JSON.parse(body)).toContainEqual({ metadata: stored.metadata, version: 31 });
	const summary = projectPath(id, "summary.json");
	const before = await fs.stat(summary);
	await route("GET");
	expect((await fs.stat(summary)).mtimeMs).toBe(before.mtimeMs);
	const full = await route("GET", id);
	expect((await full.json()).scenes).toEqual(stored.scenes);
	const renamed = { ...stored, metadata: { ...stored.metadata, name: "Renamed" } };
	expect((await route("PUT", id, "", {
		headers: { "if-match": full.headers.get("etag")! }, body: JSON.stringify(renamed),
	})).ok).toBe(true);
	expect(await (await route("GET")).json()).toContainEqual({ metadata: renamed.metadata, version: 31 });
	expect((await route("DELETE", id)).ok).toBe(true);
	expect(await (await route("GET")).json()).not.toContainEqual({ metadata: renamed.metadata, version: 31 });
});

test("navigation survives content saves without changing project bytes or their revision", async () => {
	const id = "navigation";
	const stored = {
		...fixture(id),
		scenes: [{ id: "main" }, { id: "second" }],
		timelineViewState: { zoomLevel: 1, scrollLeft: 12, playheadTime: 0 },
	};
	await writeLegacy(stored);
	const original = await fs.readFile(projectPath(id), "utf8");
	const first = await route("GET", id);
	expect((await first.json()).timelineViewState).toEqual(stored.timelineViewState);
	const navigation = { currentSceneId: "second", timelineViewState: { zoomLevel: 2, scrollLeft: 860, playheadTime: 48_000 } };
	const save = () => route("PUT", id, "navigation", { body: JSON.stringify(navigation) });
	expect((await save()).status).toBe(204);
	expect(await fs.readFile(projectPath(id), "utf8")).toBe(original);
	const sidecar = projectPath(id, "navigation.json");
	const before = await fs.stat(sidecar);
	expect(before.size).toBeLessThan(128);
	expect((await save()).status).toBe(204);
	expect(await fs.stat(sidecar)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
	expect((await route("GET", id)).headers.get("etag")).toBe(first.headers.get("etag"));
	const edited = { ...stored, metadata: { ...stored.metadata, name: "Edited" } };
	expect((await route("PUT", id, "", {
		headers: { "if-match": first.headers.get("etag")! }, body: JSON.stringify(edited),
	})).ok).toBe(true);
	expect(await (await route("GET", id)).json()).toMatchObject({ metadata: { name: "Edited" }, navigation });
	await route("DELETE", id);
	expect((await save()).status).toBe(404);
	expect(await fs.stat(projectPath(id)).catch(() => null)).toBeNull();
});

test("lists older projects with numeric-keyed tracks even when duration is missing", async () => {
	const { duration: _duration, ...metadata } = fixture("numeric-tracks", 25).metadata;
	await writeLegacy({
		...fixture(metadata.id, 25),
		metadata,
		scenes: [{ isMain: true, tracks: { 0: { elements: [{ startTime: 120_000, duration: 360_000 }] }, 1: {} } }],
	});
	await expect((await route("GET")).json()).resolves.toContainEqual({
		metadata: { ...metadata, duration: 480_000 },
		version: 25,
	});
});

test("serves old inline thumbnails as images and keeps them out of subsequent content writes", async () => {
	const id = "legacy-thumbnail";
	const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(80_000)]);
	const inline = `data:image/png;base64,${png.toString("base64")}`;
	const initial = fixture(id);
	await writeLegacy({ ...initial, metadata: { ...initial.metadata, thumbnail: inline } });
	expect((await (await route("GET")).text()).length).toBeLessThan(1024);
	const first = await route("GET", id);
	const body = await first.text();
	expect(body.length).toBeLessThan(1024);
	expect(JSON.parse(body).metadata.thumbnail).toBe(`${base}/${id}/thumbnail`);
	const legacy = await route("GET", id, "thumbnail");
	expect(legacy.headers.get("content-type")).toBe("image/png");
	expect(Buffer.from(await legacy.arrayBuffer()).equals(png)).toBe(true);
	expect((await route("PUT", id, "", { headers: { "if-match": first.headers.get("etag")! }, body })).ok).toBe(true);
	expect((await fs.stat(projectPath(id))).size).toBeLessThan(1024);
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
	const upload = await route("PUT", id, "thumbnail", { body: jpeg });
	expect(upload.status).toBe(204);
	const updated = await route("GET", id, "thumbnail");
	expect(upload.headers.get("etag")).toBe(updated.headers.get("etag"));
	expect(updated.headers.get("content-type")).toBe("image/jpeg");
	expect(new Uint8Array(await updated.arrayBuffer())).toEqual(jpeg);
	expect((await route("GET", id, "thumbnail", {
		headers: { "if-none-match": updated.headers.get("etag")! },
	})).status).toBe(304);
});

test("direct loads migrate only the requested version and the listing makes one compact request", async () => {
	const id = "open-old";
	const other = "leave-old";
	await writeLegacy(fixture(id, 30));
	await writeLegacy(fixture(other, 30));
	const paths: string[] = [];
	const handleFetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (url, init) => {
		const relative = String(url);
		paths.push(relative);
		const req = new Request(`http://localhost${relative}`, init);
		const handle = req.method === "PUT" ? PUT : GET;
		return handle(req, { params: Promise.resolve({ slug: relative.split("/").slice(3) }) });
	};
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(handleFetch, { preconnect: fetch.preconnect }),
	);
	try {
		const result = await new StorageService().loadProject({ id });
		expect(result?.project.version).toBe(31);
		expect(paths.every((url) => url === `${base}/${id}`)).toBe(true);
		expect(JSON.parse(await fs.readFile(projectPath(other), "utf8")).version).toBe(30);
		paths.length = 0;
		expect(await new StorageService().loadAllProjectsMetadata()).toContainEqual(expect.objectContaining({ id: other }));
		expect(paths).toEqual([base]);
	} finally {
		fetchSpy.mockRestore();
	}
});

test("refuses unsupported project versions without writing and still lists their metadata", async () => {
	const versions = [["future", CURRENT_PROJECT_VERSION + 1], ["future-string", String(CURRENT_PROJECT_VERSION + 1)],
		["missing-version", undefined], ["bad-version", "unknown"], ["numeric-version", String(CURRENT_PROJECT_VERSION - 1)]] as const;
	const projects = versions.map(([id, version]) => ({ ...fixture(id), version }));
	for (const project of projects) await writeLegacy(project);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
		const [, id = ""] = String(url).slice("/api/storage/".length).split("/");
		if (!id) {
			const summaries = await (await route("GET")).json() as typeof projects;
			return Response.json(summaries.filter((summary) => projects.some((project) => project.metadata.id === summary.metadata.id)));
		}
		return route(init?.method === "PUT" ? "PUT" : "GET", id, "", init);
	}, { preconnect: fetch.preconnect }));
	try {
		const storage = new StorageService();
		for (const project of projects.slice(0, 4)) {
			const { id } = project.metadata;
			const message = id.startsWith("future") ? "made with a newer version of bopencut" : "does not have a valid version";
			for (const readOnly of [false, true]) await expect(storage.loadProject({ id, readOnly })).rejects.toThrow(message);
			await expect(storage.renameProject({ id, name: "Renamed" })).rejects.toThrow(message);
			expect(await fs.readFile(projectPath(id), "utf8")).toBe(JSON.stringify(project));
		}
		expect((await storage.loadAllProjectsMetadata()).map(({ id }) => id).sort()).toEqual(versions.map(([id]) => id).sort());
		expect((await storage.loadAllProjects()).map(({ metadata, version }) => [metadata.id, version]))
			.toEqual([["numeric-version", CURRENT_PROJECT_VERSION]]);
	} finally {
		fetchSpy.mockRestore();
	}
});

test("saved human fields survive a reload and project duplication", async () => {
	const id = "ownership-round-trip";
	const clip = {
		...text("caption", 0, 2),
		agentId: "phrase",
		humanFields: ["duration", "params.content", "keyframes.constructor"],
	};
	const legacyClip = { ...text("legacy", 2, 1), agentId: "legacy" };
	const project: TProject = {
		metadata: { id, name: id, duration: t(3), createdAt: new Date(0), updatedAt: new Date(0) },
		scenes: [scene("main", {
			main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
			overlay: [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [clip, legacyClip] }],
			audio: [],
		})],
		currentSceneId: "main",
		version: CURRENT_PROJECT_VERSION,
		settings: {
			fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
	};
	const handleFetch: typeof fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
		const relative = String(url);
		const req = new Request(`http://localhost${relative}`, init);
		const handle = req.method === "PUT" ? PUT : GET;
		return handle(req, { params: Promise.resolve({ slug: relative.split("/").slice(3) }) });
	}, { preconnect: fetch.preconnect });
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(handleFetch);
	try {
		const storage = new StorageService();
		await storage.saveProject({ project });
		const loaded = await storage.loadProject({ id });
		const [duplicateId] = await EditorCore.getInstance().project.duplicateProjects({ ids: [id] });
		expect(duplicateId).toBeTruthy();
		expect(duplicateId).not.toBe(id);
		const duplicate = await storage.loadProject({ id: duplicateId });
		for (const result of [loaded, duplicate]) {
			const elements = result?.project.scenes[0].tracks.overlay[0].elements;
			expect(elements?.[0]).toMatchObject({
				agentId: "phrase", duration: t(2), humanFields: ["duration", "params.content"],
			});
			expect(elements?.[1].humanFields).toBeUndefined();
		}
	} finally {
		EditorCore.reset();
		fetchSpy.mockRestore();
	}
});

test("migration existence uses file presence without parsing the saved timeline", async () => {
	const id = "migration-presence";
	await fs.mkdir(path.dirname(projectPath(id)), { recursive: true });
	await fs.writeFile(projectPath(id), "unreadable JSON");
	try {
		const response = await route("GET", id, "migration");
		expect(response.ok).toBe(true);
		expect(await response.json()).toEqual({ exists: true });
	} finally {
		await route("DELETE", id);
	}
});

test("a saved draft import stays in both bins when its last clip is removed before promotion", async () => {
	const id = "saved-draft-media";
	const mediaAsset = { id: "voice", name: "Voice", type: "audio" as const, file: new File(["test"], "voice.wav") };
	const privateAsset = { ...mediaAsset, id: "private-voice" };
	const fetchStub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
		const relative = String(url);
		const request = new Request(`http://localhost${relative}`, init);
		const methods: Record<string, typeof GET> = { GET, HEAD, POST, PUT, DELETE };
		return methods[request.method](request, { params: Promise.resolve({ slug: relative.split("/").slice(3) }) });
	}, { preconnect: fetch.preconnect }));
	try {
		const storage = new StorageService();
		const tracks = {
			main: { id: "main", name: "Main", type: "video" as const, muted: false, hidden: false, elements: [] },
			overlay: [], audio: [],
		};
		const project: TProject = {
			metadata: { id, name: "Draft", duration: t(0), createdAt: new Date(0), updatedAt: new Date(0) },
			scenes: [scene("main", tracks)], currentSceneId: "main", version: CURRENT_PROJECT_VERSION,
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
		};
		await storage.saveProject({ project });
		await storage.saveMediaAsset({ projectId: id, mediaAsset, staged: true });
		await storage.saveMediaAsset({ projectId: id, mediaAsset: privateAsset, staged: true });
		expect(await storage.loadAllMediaAssets({ projectId: id })).toHaveLength(0);
		const manifest = () => fetch(`${base}/${id}/media`).then((response) => response.json());
		const hasMedia = (mediaId: string) => storage.hasStoredMediaAsset({ projectId: id, id: mediaId, signal: AbortSignal.timeout(1000) });
		const stale = (await manifest()).find((asset: { id: string }) => asset.id === mediaAsset.id);
		expect(stale.staged).toBe(true);
		expect(await hasMedia(mediaAsset.id)).toBe(false);
		const clip = { ...audio("voice-clip", 0, 1), mediaId: mediaAsset.id };
		const committed = { ...tracks, audio: [{ id: "a", name: "Audio", type: "audio" as const, muted: false, elements: [clip] }] };
		const rejected = await route("PUT", id, "", {
			headers: { "if-match": "stale" }, body: JSON.stringify({ ...project, scenes: [scene("main", committed)] }),
		});
		expect(rejected.status).toBe(409);
		expect(await hasMedia(mediaAsset.id)).toBe(false);
		await storage.saveProject({ project: { ...project, scenes: [scene("main", committed)] } });
		expect(await hasMedia(mediaAsset.id)).toBe(true);
		const active = await manifest();
		expect(active.find((asset: { id: string }) => asset.id === mediaAsset.id)?.staged).toBeUndefined();
		expect(active.find((asset: { id: string }) => asset.id === privateAsset.id)?.staged).toBe(true);
		await storage.saveProject({ project });
		// A delayed metadata edit from a second tab may still carry the old staged flag.
		expect((await fetch(`${base}/${id}/media/${mediaAsset.id}`, {
			method: "POST", body: JSON.stringify({ ...stale, words: [{ text: "updated", start: 0, end: 1 }] }),
		})).ok).toBe(true);
		const [copy] = await EditorCore.getInstance().project.duplicateProjects({ ids: [id] });
		const reopened = await new StorageService().loadAllMediaAssets({ projectId: id });
		const copied = await new StorageService().loadAllMediaAssets({ projectId: copy });
		for (const asset of [...reopened, ...copied]) if (asset.url) URL.revokeObjectURL(asset.url);
		expect([reopened.map(({ id }) => id), copied.map(({ id }) => id)]).toEqual([[mediaAsset.id], [mediaAsset.id]]);
		expect(reopened[0].words?.[0].text).toBe("updated");
	} finally {
		EditorCore.reset();
		fetchStub.mockRestore();
	}
});

test("browser copying marks completion only after all legacy stores have been checked", async () => {
	const storage = new Map<string, string>();
	const overrides = {
		indexedDB: {},
		localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
	};
	const originals = Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(overrides)) {
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	const legacy = spyOn(IndexedDBAdapter.prototype, "getAll").mockResolvedValue([]);
	const sounds = spyOn(IndexedDBAdapter.prototype, "get")
		.mockRejectedValueOnce(new Error("Legacy sounds unavailable"))
		.mockResolvedValue(null);
	try {
		await new StorageService().ensureMigrations();
		expect(storage.size).toBe(0);
		await new StorageService().ensureMigrations();
		expect(storage.size).toBe(1);
		await new StorageService().ensureMigrations();
		expect(legacy.mock.calls).toEqual([[{ existingOnly: true }], [{ existingOnly: true }]]);
		expect(sounds.mock.calls).toEqual([["user-sounds", { existingOnly: true }], ["user-sounds", { existingOnly: true }]]);
	} finally {
		legacy.mockRestore();
		sounds.mockRestore();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
