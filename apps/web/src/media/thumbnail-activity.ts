import type { EditorCore } from "@/core";
import { isTimelineGestureActive, subscribeTimelineGestures } from "@/timeline/gesture-state";

export function thumbnailActivity(editor: EditorCore) {
	const pointers = new Set<number>();
	let dragging = false;
	return {
		busy: () => document.hidden || pointers.size > 0 || dragging ||
			editor.playback.getIsPlaying() || editor.playback.getIsScrubbing() ||
			isTimelineGestureActive() || editor.timeline.isPreviewActive() ||
			editor.project.getExportState().isExporting || editor.renderer.isExportRunning() ||
			["count-in", "starting", "recording", "saving"].includes(editor.voiceOver.getSnapshot().phase),
		watch(check: () => void) {
			const pointerDown = (event: PointerEvent) => { pointers.add(event.pointerId); check(); };
			const pointerUp = (event: PointerEvent) => { pointers.delete(event.pointerId); check(); };
			const dragStart = () => { dragging = true; check(); };
			const stopDrag = () => { dragging = false; pointers.clear(); check(); };
			document.addEventListener("visibilitychange", check);
			window.addEventListener("pointerdown", pointerDown, true);
			window.addEventListener("pointerup", pointerUp, true);
			window.addEventListener("pointercancel", pointerUp, true);
			window.addEventListener("dragstart", dragStart, true);
			window.addEventListener("dragend", stopDrag, true);
			window.addEventListener("drop", stopDrag, true);
			window.addEventListener("blur", stopDrag);
			const stops = [editor.playback.subscribeState(check), editor.timeline.subscribe(check),
				subscribeTimelineGestures(check), editor.project.subscribe(check), editor.renderer.subscribe(check),
				editor.voiceOver.subscribe(check)];
			return () => {
				document.removeEventListener("visibilitychange", check);
				window.removeEventListener("pointerdown", pointerDown, true);
				window.removeEventListener("pointerup", pointerUp, true);
				window.removeEventListener("pointercancel", pointerUp, true);
				window.removeEventListener("dragstart", dragStart, true);
				window.removeEventListener("dragend", stopDrag, true);
				window.removeEventListener("drop", stopDrag, true);
				window.removeEventListener("blur", stopDrag);
				stops.forEach((stop) => stop());
				pointers.clear();
				dragging = false;
			};
		},
		idle(run: () => void) {
			if (typeof requestIdleCallback === "function") {
				const id = requestIdleCallback(run);
				return () => cancelIdleCallback(id);
			}
			const id = setTimeout(run, 32);
			return () => clearTimeout(id);
		},
	};
}
