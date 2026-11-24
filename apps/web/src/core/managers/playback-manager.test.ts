import { afterEach, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { storageService } = await import("@/services/storage/service");

const t = (seconds: number) => mediaTimeFromSeconds({ seconds });
const stored = {
	metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
	currentSceneId: "main",
	scenes: [{
		id: "main", name: "Main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: {
			main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [{
				id: "clip", type: "text", name: "clip", startTime: t(0), duration: t(10), trimStart: t(0), trimEnd: t(0), params: { content: "x" },
			}] },
			overlay: [], audio: [],
		},
	}],
	settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" } },
} as unknown as TProject;

afterEach(() => EditorCore.reset());

test("keyboard seek debounces playhead into view state without timeline edits", async () => {
	let timelineWrites = 0;
	const editor = EditorCore.getInstance();
	Object.assign(storageService, {
		ensureMigrations: async () => {},
		loadProject: async () => ({ project: structuredClone(stored) }),
		loadAllMediaAssets: async () => [],
		saveProject: async () => { timelineWrites++; },
		saveProjectNavigation: async () => {},
	});
	await editor.project.loadProject({ id: "p" });
	const saves: MediaTime[] = [];
	const setView = editor.project.setTimelineViewState.bind(editor.project);
	editor.project.setTimelineViewState = (args) => { saves.push(args.viewState.playheadTime); setView(args); };
	editor.playback.seek({ time: t(1) });
	editor.playback.seek({ time: t(2) });
	editor.playback.seek({ time: t(3) });
	await Bun.sleep(250);
	expect(saves).toEqual([t(3)]);
	const raf = globalThis.requestAnimationFrame;
	globalThis.requestAnimationFrame = () => 0;
	editor.playback.play();
	(editor.playback as unknown as { updateTime: () => void }).updateTime();
	expect(saves).toEqual([t(3)]);
	editor.playback.pause();
	globalThis.requestAnimationFrame = raf;
	expect(timelineWrites).toBe(0);
});