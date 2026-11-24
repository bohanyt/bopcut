import { afterEach, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import { DEFAULT_NEW_ELEMENT_DURATION, toElementDurationTicks } from "@/timeline/creation";
import { mediaTimeToSeconds } from "@/wasm";
import { allElements, allTracks, fixture, t } from "./compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { InsertElementCommand } = await import("@/commands/timeline");

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

afterEach(() => EditorCore.reset());

test.each([
	[0, DEFAULT_NEW_ELEMENT_DURATION],
	[-1, DEFAULT_NEW_ELEMENT_DURATION],
	[null, DEFAULT_NEW_ELEMENT_DURATION],
	[undefined, DEFAULT_NEW_ELEMENT_DURATION],
] as const)("toElementDurationTicks(%p) uses default", (seconds, expected) => {
	expect(toElementDurationTicks({ seconds })).toBe(expected);
});

test("toElementDurationTicks(0.001) is positive", () => {
	expect(mediaTimeToSeconds({ time: toElementDurationTicks({ seconds: 0.001 }) })).toBeGreaterThan(0);
});

test("toElementDurationTicks(NaN) throws", () => {
	expect(() => toElementDurationTicks({ seconds: NaN })).toThrow();
});

test("InsertElementCommand with duration 0 inserts the default length", () => {
	const editor = setup();
	const command = new InsertElementCommand({
		element: { type: "text", name: "t", startTime: t(0), duration: t(0), trimStart: t(0), trimEnd: t(0), params: { content: "t" } },
		placement: { mode: "auto" },
	});
	editor.command.execute({ command });
	const inserted = allElements(allTracks(editor.scenes.getActiveScene().tracks)).find((e) => e.id === command.getElementId());
	expect(inserted?.duration).toBe(DEFAULT_NEW_ELEMENT_DURATION);
});