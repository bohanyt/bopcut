import { create } from "zustand";
import type { EditorCore } from "@/core";
import type { Bookmark } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { getFrameTime } from "./utils";

type AreaTarget = { projectId: string; sceneId: string; time: MediaTime; bookmark?: Bookmark };
export const useBookmarkArea = create<{ editing: AreaTarget | null; shown: AreaTarget | null; hovered: AreaTarget | null }>(() => ({
	editing: null,
	shown: null,
	hovered: null,
}));

export function areaTarget(editor: EditorCore, time: MediaTime): AreaTarget {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const frame = getFrameTime({ time, fps: project.settings.fps });
	return { projectId: project.metadata.id, sceneId: scene.id, time: frame, bookmark: scene.bookmarks.find((b) => b.time === frame) };
}

export function startBookmarkArea(editor: EditorCore, time: MediaTime) {
	editor.playback.pause();
	const target = areaTarget(editor, time);
	editor.playback.seek({ time: target.time });
	useBookmarkArea.setState({ editing: target });
}
