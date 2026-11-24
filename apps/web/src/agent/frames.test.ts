import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { TProject, TProjectSettings } from "@/project/types";
import type { TScene } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { startBookmarkArea, useBookmarkArea } from "@/timeline/bookmarks/area-state";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { pollFrames } = await import("./frames");
const { installAgentBridge, pollExport } = await import("./bridge");
const { snapshotHistory } = await import("./history");
const graphics = await import("@/services/renderer/renderer-device");
const { rendererDevice } = graphics;
const { storageService, normalizeBookmarks } = await import("@/services/storage/service");
const fonts = await import("@/fonts/google-fonts");

const T = (seconds: number) => mediaTimeFromSeconds({ seconds });
const date = new Date(0);
const scene = (id: string, duration: number): TScene => ({
	id, name: id, isMain: id === "a", bookmarks: [], createdAt: date, updatedAt: date,
	tracks: {
		overlay: [], audio: [],
		main: {
			id: `track-${id}`, name: "Main", type: "video", muted: false, hidden: false,
			elements: [{ id: `clip-${id}`, name: "Image", type: "image", mediaId: "image", params: {}, startTime: T(0), duration: T(duration), trimStart: T(0), trimEnd: T(0) }],
		},
	},
});

const settings: TProjectSettings = {
	canvasSize: { width: 1920, height: 1080 },
	background: { type: "color", color: "#000000" },
	fps: { numerator: 30, denominator: 1 },
};

function setup({ compare, times = [0, 1.95], pauseAt = "/api/agent/frame", pauseAfterFrames, realisticFramePaths = false, failCancellation = false, failResult, imageSize = settings.canvasSize }: {
	compare?: { syncedAt: string }; times?: readonly number[]; pauseAt?: string; pauseAfterFrames?: number; realisticFramePaths?: boolean; failCancellation?: boolean;
	failResult?: "HTTP error" | "network error";
	imageSize?: { width: number; height: number };
} = {}) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = [scene("a", 2), scene("b", 3)];
	const open = (id: string) => {
		const project: TProject = {
			metadata: { id, name: id, duration: T(0), createdAt: date, updatedAt: date },
			scenes, currentSceneId: "a", settings, version: 1,
		};
		editor.project.setActiveProject({ project });
		editor.scenes.setScenes({ scenes, activeSceneId: "a" });
	};
	open("p");
	const render = spyOn(editor.renderer, "createSnapshot").mockResolvedValue({ success: true, blob: new Blob(["image"]), filename: "frame.png" });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const results: unknown[] = [];
	const uploads: FormData[] = [];
	const drawImage = mock((_image: ImageBitmap, _x: number, _y: number, _width: number, _height: number) => {});
	const stored = new Map<string, string>();
	const frameStore = new Map<string, true>();
	let paused = false;
	let failed = false;
	const globals = {
		fetch: async (input: string, init?: RequestInit) => {
			const action = new URL(input, "http://localhost").searchParams.get("action");
			const url = action ? `/api/agent/${action}` : input;
			if (action === "watch") return new Promise<Response>(() => {});
			if (url === pauseAt && !paused) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			if (action === "stage") return Response.json({ ok: true });
			if (url === "/api/agent/frames-request") return Response.json({ rev: "frame-test", compare, times });
			if (url === "/api/agent/frame") {
				const form = init?.body as FormData;
				uploads.push(form);
				if (realisticFramePaths) {
					const rev = String(form.get("rev"));
					const time = String(form.get("time"));
					const variant = form.get("variant");
					const name = variant === "compare" ? `${time}-compare.jpg` : `${time}.jpg`;
					frameStore.set(`frames/${rev}/${name}`, true);
					if (form.has("crop")) frameStore.set(`frames/${rev}/${time}-crop.jpg`, true);
				}
				if (pauseAfterFrames && uploads.length === pauseAfterFrames && !paused) {
					paused = true;
					entered.resolve();
					await release.promise;
				}
				const payload = realisticFramePaths
					? (() => {
						const rev = String(form.get("rev"));
						const time = String(form.get("time"));
						const variant = form.get("variant");
						const name = variant === "compare" ? `${time}-compare.jpg` : `${time}.jpg`;
						return { file: `frames/${rev}/${name}`, ...(form.has("crop") && { crop: `frames/${rev}/${time}-crop.jpg` }) };
					})()
					: { file: `frame-${uploads.length}.jpg`, ...(uploads.at(-1)?.has("crop") && { crop: "note-crop.jpg" }) };
				return Response.json(payload);
			}
			if (url === "/api/agent/frames-result") {
				const result = JSON.parse(init?.body as string);
				for (const rel of result.discard ?? []) frameStore.delete(rel);
				const { discard: _discard, ...posted } = result;
				if (posted.files.length && failResult) {
					if (failResult === "network error") throw new Error("Network error");
					return new Response("Write failed", { status: 500 });
				}
				if (failCancellation && !failed && posted.error?.startsWith("cancelled:")) {
					failed = true;
					return new Response(null, { status: 500 });
				}
				results.push(posted);
				return Response.json({});
			}
			throw new Error(`Unexpected request: ${url}`);
		},
		localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
		createImageBitmap: async () => ({ ...imageSize, close() {} }),
		document: { createElement: () => ({ getContext: () => ({ drawImage, strokeRect() {} }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["jpeg"])) }) },
	};
	for (const [key, value] of Object.entries(globals)) {
		const original = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		cleanups.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
	}
	cleanups.push(() => render.mockRestore());
	return { editor, scenes, open, render, uploads, results, drawImage, frameStore, entered: entered.promise, release: release.resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	useBookmarkArea.setState({ editing: null });
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	EditorCore.reset();
});

test("area editing pauses on entry and cancels on external playback, seeks, and scene changes", () => {
	const { editor, scenes } = setup();
	for (const [key, value] of Object.entries({ requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {} })) {
		const original = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { value, configurable: true });
		cleanups.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
	}
	editor.playback.play();
	startBookmarkArea(editor, T(1));
	expect(editor.playback.getIsPlaying()).toBe(false);
	expect(useBookmarkArea.getState().editing?.time).toBe(T(1));
	editor.playback.seek({ time: T(0) });
	expect(useBookmarkArea.getState().editing).toBeNull();
	startBookmarkArea(editor, T(1));
	editor.playback.play();
	expect(useBookmarkArea.getState().editing).toBeNull();
	editor.playback.pause();
	startBookmarkArea(editor, T(1));
	editor.scenes.setScenes({ scenes, activeSceneId: "b" });
	expect(useBookmarkArea.getState().editing).toBeNull();
});

test("pointing at an area is unavailable during voice-over capture and cannot pause it", () => {
	const { editor } = setup();
	const capture = spyOn(editor.voiceOver, "isCapturing").mockReturnValue(true);
	const pause = spyOn(editor.playback, "pause");
	try {
		startBookmarkArea(editor, T(1));
		expect(useBookmarkArea.getState().editing).toBeNull();
		expect(pause).not.toHaveBeenCalled();
	} finally {
		capture.mockRestore();
		pause.mockRestore();
	}
});

test("an area note captures its own scene and uploads the annotated frame and clean crop together", async () => {
	const { editor, scenes, uploads, results, render, drawImage } = setup({ pauseAt: "" });
	const box = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
	const compound = { ...scenes[1], kind: "compound" as const, bookmarks: [{ id: "area", note: "Smaller", time: T(1), box }] };
	editor.scenes.setScenes({ scenes: [scenes[0], compound], activeSceneId: "a" });
	await pollFrames(() => ({ ready: true, missingMedia: [] }), Response.json({ rev: "area-frame", noteId: "area", sceneId: "b" }));
	expect(render.mock.calls[0][0]).toMatchObject({ time: T(1), sceneId: "b" });
	expect(uploads[0].get("crop")).toBeInstanceOf(Blob);
	expect(drawImage.mock.calls[1].slice(1)).toEqual([480, 270, 960, 270, 0, 0, 768, 216]);
	expect(results).toEqual([{ rev: "area-frame", projectId: "p", files: ["frame-1.jpg"], crop: "note-crop.jpg", box }]);
});

test("creating an area note is one undoable edit and old bookmarks still load", async () => {
	const { editor } = setup();
	const time = T(1);
	const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
	await editor.scenes.updateBookmark({ time, create: true, updates: { box, note: "Smaller" } });
	const saved = editor.scenes.getActiveScene().bookmarks;
	expect(normalizeBookmarks({ raw: JSON.parse(JSON.stringify([T(0), ...saved])) }))
		.toEqual([{ time: T(0) }, { time, box, note: "Smaller" }]);
	editor.command.undo();
	expect(editor.scenes.getActiveScene().bookmarks).toEqual([]);
});

test("a render-only core hydrates a saved project without opening a save session or installing the bridge", async () => {
	EditorCore.reset();
	const editor = EditorCore.createRenderOnly();
	expect(() => EditorCore.createRenderOnly()).toThrow("own page");
	const project: TProject = {
		metadata: { id: "render", name: "Render", duration: T(0), createdAt: date, updatedAt: date },
		currentSceneId: "", scenes: [], settings, version: 31,
	};
	const load = spyOn(storageService, "loadProject").mockResolvedValue({ project });
	const media = spyOn(storageService, "loadAllMediaAssets").mockResolvedValue([]);
	cleanups.push(() => { load.mockRestore(); media.mockRestore(); });
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const window = {};
	Object.defineProperty(globalThis, "window", { value: window, configurable: true });
	cleanups.push(() => previousWindow ? Object.defineProperty(globalThis, "window", previousWindow) : Reflect.deleteProperty(globalThis, "window"));
	installAgentBridge();
	expect(window).toEqual({});
	await editor.project.loadForRender("render", async () => {});
	expect(load).toHaveBeenCalledWith({ id: "render", readOnly: true });
	expect(editor.save.getCurrent()).toBeNull();
	expect(editor.scenes.getScenes()).toHaveLength(1);
	await pollFrames(() => { throw new Error("render-only poll read an unassigned request"); });
	await pollExport();
});

test("a range job can hydrate the project without waiting for project-wide fonts", async () => {
	const editor = EditorCore.createRenderOnly();
	const saved = scene("a", 10);
	saved.tracks.overlay.push({
		id: "titles", type: "text", name: "Titles", hidden: false,
		elements: [{
			id: "later-title", name: "Later title", type: "text", startTime: T(5), duration: T(1), trimStart: T(0), trimEnd: T(0),
			params: { content: "Later", fontFamily: "Remote font" },
		}],
	});
	const project: TProject = {
		metadata: { id: "range", name: "Range", duration: T(10), createdAt: date, updatedAt: date },
		currentSceneId: saved.id, scenes: [saved], settings, version: 31,
	};
	const load = spyOn(storageService, "loadProject").mockResolvedValue({ project });
	const media = spyOn(storageService, "loadAllMediaAssets").mockResolvedValue([]);
	const loadFonts = spyOn(fonts, "loadFonts").mockResolvedValue(undefined);
	cleanups.push(() => { load.mockRestore(); media.mockRestore(); loadFonts.mockRestore(); });
	await editor.project.loadForRender("range", async () => {}, { skipFonts: true });
	expect(loadFonts).not.toHaveBeenCalled();
});

const ready = () => ({ ready: true, missingMedia: [] });

test("CLI frame capture finishes while its progress response is delayed", async () => {
	const { render, results, entered, release } = setup({ pauseAt: "/api/agent/stage", times: [0] });
	const response = Response.json({ rev: "cli-frames", times: [0] }, { headers: { "x-bopencut-render-token": "token" } });
	const capture = pollFrames(ready, response);
	try {
		await entered;
		expect(await Promise.race([capture.then(() => "done"), Bun.sleep(100).then(() => "blocked")])).toBe("done");
		expect(render).toHaveBeenCalledTimes(1);
		expect(results).toEqual([{ rev: "cli-frames", projectId: "p", files: ["frame-1.jpg"] }]);
	} finally {
		release();
		await capture;
	}
});

test("invalid workspace frame requests receive one error from the matching project", async () => {
	const { results, render, open } = setup({ pauseAt: "" });
	const poll = (body: object) => pollFrames(ready, Response.json(body));
	await poll({ rev: "bad/rev", width: false });
	await poll({ rev: "bad-times", times: [-1], projectId: "another" });
	expect(results).toEqual([]);
	for (let attempt = 0; attempt < 2; attempt++) {
		await poll({ rev: "bad-times", times: [-1], projectId: "p" });
		await poll({ rev: "bad-width", times: [0], width: 4097 });
	}
	open("other");
	await poll({ rev: "bad-width", times: [0], width: 4097 });
	expect(results).toEqual(["bad-times", "bad-width"].map((rev) => ({ rev, projectId: "p", files: [], error: expect.any(String) })));
	expect(render).not.toHaveBeenCalled();
});

test("agent frame resizing caps the height of a narrow portrait canvas", async () => {
	const { drawImage, results } = setup({ pauseAt: "", times: [0], imageSize: { width: 64, height: 4096 } });
	const limits = spyOn(graphics, "getRendererLimits")
		.mockReturnValue({ maxTextureDimension: 4096, maxSurfaceDimension: 4096 });
	cleanups.push(() => limits.mockRestore());
	await pollFrames(ready);
	expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 64, 4096);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: ["frame-1.jpg"] }]);
});

test("a frames request remains unanswered through graphics startup and recovery", async () => {
	const { render, results, entered, release } = setup({ pauseAt: "/api/agent/frames-request", times: [0] });
	let state = "starting";
	Object.defineProperty(rendererDevice, "status", { configurable: true, get: () => ({ state }) });
	cleanups.push(() => { Reflect.deleteProperty(rendererDevice, "status"); });
	const starting = pollFrames(ready);
	try {
		await Promise.race([
			starting,
			entered.then(() => { throw new Error("Read a frames request during graphics startup"); }),
		]);
		state = "ready";
		const pending = pollFrames(ready);
		await entered;
		state = "recovering";
		release();
		await pending;
		expect(results).toEqual([]);
		expect(render).not.toHaveBeenCalled();
		state = "ready";
		await pollFrames(ready);
		expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: ["frame-1.jpg"] }]);
	} finally {
		release();
		await starting;
	}
});

test("keeps the live and compare states fixed across a frame upload", async () => {
	const { editor, scenes, render, results, entered, release } = setup({ compare: { syncedAt: "compare-frame" } });
	const pastScenes = [scene("past", 3)];
	const pastSettings = { ...settings, canvasSize: { width: 640, height: 480 } };
	snapshotHistory.record("compare-frame", pastScenes, { projectId: "p", rootSceneId: "past", settings: pastSettings });
	editor.media.setAssets({ assets: [{ id: "image", type: "image", name: "Image", file: new File([], "image.png") }] });
	let isReady = true;
	const running = pollFrames(() => ({ ready: isReady, missingMedia: [] }));
	await entered;
	try {
		isReady = false;
		editor.scenes.setScenes({ scenes: [scene("a", 1), scenes[1]], activeSceneId: "b" });
		await editor.project.updateSettings({
			settings: { canvasSize: { width: 1080, height: 1920 }, fps: { numerator: 10, denominator: 1 }, background: { type: "color", color: "#ffffff" } },
			pushHistory: false,
		});
	} finally {
		release();
		await running;
	}
	expect(render.mock.calls.map(([args]) => [args?.sceneId, args?.settings])).toEqual([
		["a", settings], ["past", pastSettings], ["a", settings], ["past", pastSettings],
	]);
	expect(render.mock.calls[2]?.[0]?.scenes).toBe(scenes);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: ["frame-1.jpg", "frame-3.jpg"], compare: ["frame-2.jpg", "frame-4.jpg"] }]);
});

test.each([true, false])("checks the current root and readiness when the request arrives (ready: %s)", async (isReady) => {
	const { editor, render, results, entered, release } = setup({ pauseAt: "/api/agent/frames-request", times: [0] });
	let ready = true;
	const running = pollFrames(() => ({ ready, missingMedia: [] }));
	await entered;
	try {
		ready = isReady;
		await editor.scenes.switchToScene({ sceneId: "b" });
	} finally {
		release();
		await running;
	}
	if (isReady) {
		expect(render.mock.calls[0]?.[0]?.sceneId).toBe("b");
		expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: ["frame-1.jpg"] }]);
	} else {
		expect(render).not.toHaveBeenCalled();
		expect(results).toEqual([]);
	}
});

test.each([{ times: [0, 1] }, { times: [0] }])("cancels during an upload after returning to the same project ($times)", async ({ times }) => {
	const { open, render, results, entered, release } = setup({ times });
	const running = pollFrames(ready);
	await entered;
	try {
		open("q");
		open("p");
	} finally {
		release();
		await running;
	}
	expect(render).toHaveBeenCalledTimes(1);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: [], error: "cancelled: the project session changed during the frame request" }]);
});

test("leaves a cancelled request answered after a project switch", async () => {
	const { open, render, results, entered, release } = setup();
	const running = pollFrames(ready);
	await entered;
	try {
		open("q");
	} finally {
		release();
		await running;
	}
	await pollFrames(ready);
	expect(render).toHaveBeenCalledTimes(1);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: [], error: "cancelled: the project session changed during the frame request" }]);
});

test("retries a failed cancellation for the original project", async () => {
	const { open, render, results, entered, release } = setup({ failCancellation: true });
	const running = pollFrames(ready);
	await entered;
	try {
		open("q");
	} finally {
		release();
		await running;
	}
	expect(results).toEqual([]);
	await pollFrames(ready);
	expect(render).toHaveBeenCalledTimes(1);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", files: [], error: "cancelled: the project session changed during the frame request" }]);
});

test.each([
	{ failResult: "HTTP error", expected: { files: [], error: "cancelled: the project session changed during the frame request" } },
	{ failResult: "network error", expected: { files: [], error: "cancelled: the project session changed during the frame request" } },
	{ failResult: undefined, expected: { files: ["frame-1.jpg"] } },
] as const)("keeps a result post bound to its project during a switch ($failResult)", async ({ failResult, expected }) => {
	const { open, render, results, entered, release } = setup({ pauseAt: "/api/agent/frames-result", times: [0], failResult });
	const running = pollFrames(ready);
	await entered;
	try {
		open("q");
	} finally {
		release();
		await running;
	}
	await pollFrames(ready);
	expect(render).toHaveBeenCalledTimes(1);
	expect(results).toEqual([{ rev: "frame-test", projectId: "p", ...expected }]);
});

test("discards written frames when a batch is cancelled", async () => {
	const rev = "frame-test";
	const { open, render, results, entered, release, frameStore } = setup({ times: [0, 0.5, 1, 1.5], pauseAfterFrames: 2, pauseAt: "", realisticFramePaths: true });
	frameStore.set(`frames/${rev}/legacy.jpg`, true);
	const running = pollFrames(ready);
	await entered;
	try {
		open("q");
		open("p");
	} finally {
		release();
		await running;
	}
	expect(render).toHaveBeenCalledTimes(2);
	expect(results).toEqual([{ rev, projectId: "p", files: [], error: "cancelled: the project session changed during the frame request" }]);
	expect(frameStore.has(`frames/${rev}/0.jpg`)).toBe(false);
	expect(frameStore.has(`frames/${rev}/0.5.jpg`)).toBe(false);
	expect(frameStore.has(`frames/${rev}/legacy.jpg`)).toBe(true);

	const done = setup({ times: [0, 0.5, 1, 1.5], pauseAt: "", realisticFramePaths: true });
	await pollFrames(ready);
	expect(done.results).toEqual([{ rev, projectId: "p", files: ["frames/frame-test/0.jpg", "frames/frame-test/0.5.jpg", "frames/frame-test/1.jpg", "frames/frame-test/1.5.jpg"] }]);
	for (const time of [0, 0.5, 1, 1.5]) expect(done.frameStore.has(`frames/${rev}/${time}.jpg`)).toBe(true);
});

test("reports media removed between live frames instead of rendering without them", async () => {
	const { editor, render, results, entered, release } = setup();
	editor.media.setAssets({ assets: [{ id: "image", type: "image", name: "Image", file: new File([], "image.png") }] });
	const running = pollFrames(ready);
	await entered;
	try {
		editor.media.setAssets({ assets: [] });
	} finally {
		release();
		await running;
	}
	expect(render).toHaveBeenCalledTimes(1);
	expect(results).toEqual([{
		rev: "frame-test", projectId: "p", files: ["frame-1.jpg"],
		errors: [{ time: 1.95, error: expect.stringContaining("Image") }],
	}]);
});
