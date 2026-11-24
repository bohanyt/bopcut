import { create } from "zustand";
import { toast } from "sonner";
import { getBrowserTranslator } from "@/i18n/browser";
import type { EditorCore } from "@/core";
import type { Bookmark } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { getFrameTime } from "./utils";

type AreaTarget = { session: number; projectId: string; sceneId: string; time: MediaTime; bookmark?: Bookmark };
export const useBookmarkArea = create<{ editing: AreaTarget | null; shown: AreaTarget | null; hovered: AreaTarget | null }>(() => ({
	editing: null,
	shown: null,
	hovered: null,
}));

export function areaTarget(editor: EditorCore, time: MediaTime): AreaTarget {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const frame = getFrameTime({ time, fps: project.settings.fps });
	return { session: editor.project.getSession(), projectId: project.metadata.id, sceneId: scene.id, time: frame, bookmark: scene.bookmarks.find((b) => b.time === frame) };
}

export function startBookmarkArea(editor: EditorCore, time: MediaTime) {
	if (editor.voiceOver.isCapturing()) return;
	useBookmarkArea.setState({ editing: null });
	editor.playback.pause();
	const lastFrame = editor.timeline.getLastFrameTime();
	const target = areaTarget(editor, time > lastFrame ? lastFrame : time);
	editor.playback.seek({ time: target.time });
	useBookmarkArea.setState({ editing: target });
	const cancel = () => {
		if (useBookmarkArea.getState().editing !== target) return;
		useBookmarkArea.setState({ editing: null });
		toast.info(getBrowserTranslator()("bookmark.areaInterrupted"), { style: { pointerEvents: "none" } });
	};
	const checkScene = () => {
		if (editor.project.getSession() !== target.session ||
			editor.scenes.getActiveSceneOrNull()?.id !== target.sceneId) cancel();
	};
	const stop = [
		editor.playback.onPlaybackInterrupt(cancel),
		editor.playback.onSeek((time) => { if (time !== target.time) cancel(); }),
		editor.playback.subscribeState(() => { if (editor.playback.getIsPlaying()) cancel(); }),
		editor.scenes.subscribe(checkScene),
		editor.project.subscribe(checkScene),
		editor.voiceOver.subscribe(() => { if (editor.voiceOver.isCapturing()) cancel(); }),
	];
	const unsubscribe = useBookmarkArea.subscribe((state) => {
		if (state.editing === target) return;
		unsubscribe();
		for (const cleanup of stop) cleanup();
	});
}
