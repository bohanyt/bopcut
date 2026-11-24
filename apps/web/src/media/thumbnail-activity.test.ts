import { expect, spyOn, test } from "bun:test";
import { EditorCore } from "@/core";
import { beginTimelineGesture } from "@/timeline/gesture-state";
import { thumbnailActivity } from "./thumbnail-activity";

test("thumbnail generation pauses for playback, scrubbing, editing, recording, export, and hidden tabs", () => {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const documentProperty = Object.getOwnPropertyDescriptor(globalThis, "document");
	const document = { hidden: false };
	const playing = spyOn(editor.playback, "getIsPlaying");
	const preview = spyOn(editor.timeline, "isPreviewActive");
	const exporting = spyOn(editor.renderer, "isExportRunning");
	const voice = spyOn(editor.voiceOver, "getSnapshot");
	const initial = editor.voiceOver.getSnapshot();
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	try {
		const { busy } = thumbnailActivity(editor);
		expect(busy()).toBe(false);
		playing.mockReturnValue(true);
		expect(busy()).toBe(true);
		playing.mockReturnValue(false);
		editor.playback.setScrubbing({ isScrubbing: true });
		expect(busy()).toBe(true);
		editor.playback.setScrubbing({ isScrubbing: false });
		const endDrag = beginTimelineGesture();
		try { expect(busy()).toBe(true); } finally { endDrag(); }
		preview.mockReturnValue(true);
		expect(busy()).toBe(true);
		preview.mockReturnValue(false);
		for (const phase of ["count-in", "starting", "recording", "saving"] as const) {
			voice.mockReturnValue({ ...initial, phase });
			expect(busy()).toBe(true);
		}
		voice.mockReturnValue(initial);
		exporting.mockReturnValue(true);
		expect(busy()).toBe(true);
		exporting.mockReturnValue(false);
		document.hidden = true;
		expect(busy()).toBe(true);
		document.hidden = false;
		expect(busy()).toBe(false);
	} finally {
		playing.mockRestore();
		preview.mockRestore();
		exporting.mockRestore();
		voice.mockRestore();
		if (documentProperty) Object.defineProperty(globalThis, "document", documentProperty);
		else Reflect.deleteProperty(globalThis, "document");
		EditorCore.reset();
	}
});
