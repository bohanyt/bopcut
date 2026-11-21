import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { TProject, TProjectSettings } from "@/project/types";
import type { TScene } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { pollFrames } = await import("./frames");
const { snapshotHistory } = await import("./history");

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

function setup({ compare, times = [0, 1.95], pauseAt = "/api/agent/frame", failCancellation = false, failResult }: {
	compare?: { syncedAt: string }; times?: readonly number[]; pauseAt?: string; failCancellation?: boolean;
	failResult?: "HTTP error" | "network error";
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
	const stored = new Map<string, string>();
	let paused = false;
	let failed = false;
	const globals = {
		fetch: async (url: string, init?: RequestInit) => {
			if (url === pauseAt && !paused) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			if (url === "/api/agent/frames-request") return Response.json({ rev: "frame-test", compare, times });
			if (url === "/api/agent/frame") {
				uploads.push(init?.body as FormData);
				return Response.json({ file: `frame-${uploads.length}.jpg` });
			}
			if (url === "/api/agent/frames-result") {
				const result = JSON.parse(init?.body as string);
				if (result.files.length && failResult) {
					if (failResult === "network error") throw new Error("Network error");
					return new Response("Write failed", { status: 500 });
				}
				if (failCancellation && !failed && result.error?.startsWith("cancelled:")) {
					failed = true;
					return new Response(null, { status: 500 });
				}
				results.push(result);
				return Response.json({});
			}
			throw new Error(`Unexpected request: ${url}`);
		},
		localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
		createImageBitmap: async () => ({ width: 1920, height: 1080, close() {} }),
		document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["jpeg"])) }) },
	};
	for (const [key, value] of Object.entries(globals)) {
		const original = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		cleanups.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
	}
	cleanups.push(() => render.mockRestore());
	return { editor, scenes, open, render, uploads, results, entered: entered.promise, release: release.resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	EditorCore.reset();
});

const ready = () => ({ ready: true, missingMedia: [] });

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
