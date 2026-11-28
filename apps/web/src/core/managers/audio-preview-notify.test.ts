import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EditorCore } from "@/core";
import { AudioManager } from "@/core/managers/audio-manager";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

const frames = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
beforeEach(() => {
	// Playback ticks on animation frames; nothing has to run for these checks.
	globalThis.requestAnimationFrame = () => 1;
	globalThis.cancelAnimationFrame = () => {};
});
afterEach(() => {
	EditorCore.getInstance().playback.pause();
	EditorCore.reset();
	globalThis.requestAnimationFrame = frames.request;
	globalThis.cancelAnimationFrame = frames.cancel;
});

function setup() {
	const subject = video("target", 0, 4);
	const scenes = fixture();
	const root = getHost(scenes);
	root.tracks.main.elements = [subject];
	root.tracks.audio = [];
	const editor = EditorCore.getInstance();
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "Project", duration: t(4), createdAt: date, updatedAt: date },
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1000, height: 1000 },
				background: { type: "color", color: "#000000" },
			},
			currentSceneId: "main",
			scenes,
			version: 1,
		},
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	const ref = { trackId: root.tracks.main.id, elementId: subject.id };
	const disposeSinks = spyOn(AudioManager.prototype as unknown as { disposeSinks: () => void }, "disposeSinks");
	editor.playback.play();
	disposeSinks.mockClear();
	return { editor, ref, disposeSinks };
}

test("a drag in progress in the preview leaves the playing sound alone; its commit restarts it", () => {
	const { editor, ref, disposeSinks } = setup();
	try {
		for (let move = 0; move < 5; move++) {
			editor.timeline.previewElements({
				updates: [{ ...ref, updates: { params: { "transform.positionX": move * 10 } } }],
				replace: true,
			});
		}
		expect(disposeSinks).toHaveBeenCalledTimes(0);

		editor.timeline.commitPreview();
		expect(disposeSinks.mock.calls.length).toBeGreaterThan(0);
	} finally {
		disposeSinks.mockRestore();
	}
});

test("a discarded preview and an undone edit still reach the sound when the tracks change", () => {
	const { editor, ref, disposeSinks } = setup();
	try {
		editor.timeline.previewElements({ updates: [{ ...ref, updates: { params: { "transform.positionX": 5 } } }], replace: true });
		editor.timeline.discardPreview();
		expect(disposeSinks).toHaveBeenCalledTimes(0);

		editor.timeline.previewElements({ updates: [{ ...ref, updates: { startTime: t(1) } }], replace: true });
		editor.timeline.commitPreview();
		disposeSinks.mockClear();
		editor.command.undo();
		expect(disposeSinks.mock.calls.length).toBeGreaterThan(0);
	} finally {
		disposeSinks.mockRestore();
	}
});

test("the shuttle forwards schedules the sound again at its speed; backwards stops it", () => {
	const { editor } = setup();
	const start = spyOn(AudioManager.prototype as unknown as { startPlayback: () => Promise<void> }, "startPlayback");
	const stop = spyOn(AudioManager.prototype as unknown as { stopPlayback: () => void }, "stopPlayback");
	try {
		editor.playback.setRate(2);
		expect(start).toHaveBeenCalledTimes(1);
		const stopsBefore = stop.mock.calls.length;
		editor.playback.setRate(-1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(stop.mock.calls.length).toBe(stopsBefore + 1);
	} finally {
		start.mockRestore();
		stop.mockRestore();
	}
});
