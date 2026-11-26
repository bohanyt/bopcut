import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Bookmark, TScene } from "@/timeline";
import { updateSceneInArray } from "@/timeline/scenes";
import { getFrameTime, moveBookmarkInArray } from "@/timeline/bookmarks/index";
import type { MediaTime } from "@/wasm";

export class MoveBookmarkCommand extends Command {
	private savedScenes: TScene[] | null = null;
	/** The scenes this command produced, so Redo restores them even when the bookmark object it addressed was replaced. */
	private appliedScenes: TScene[] | null = null;

	constructor({
		fromTime,
		toTime,
		bookmark,
	}: {
		fromTime: MediaTime;
		toTime: MediaTime;
		bookmark?: Bookmark;
	}) {
		super();
		this.fromTime = fromTime;
		this.toTime = toTime;
		this.bookmark = bookmark;
	}

	private fromTime: MediaTime;
	private toTime: MediaTime;
	private bookmark?: Bookmark;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeScene = editor.scenes.getActiveScene();
		const activeProject = editor.project.getActive();

		if (!activeScene || !activeProject) {
			return;
		}

		const scenes = editor.scenes.getScenes();
		this.savedScenes = [...scenes];

		const fromFrameTime = getFrameTime({
			time: this.fromTime,
			fps: activeProject.settings.fps,
		});
		const toFrameTime = getFrameTime({
			time: this.toTime,
			fps: activeProject.settings.fps,
		});

		const updatedBookmarks = moveBookmarkInArray({
			bookmarks: activeScene.bookmarks,
			fromTime: fromFrameTime,
			toTime: toFrameTime,
			bookmark: this.bookmark,
		});
		if (updatedBookmarks === activeScene.bookmarks) return { changed: false };

		const updatedScenes = updateSceneInArray({
			scenes,
			sceneId: activeScene.id,
			updates: { bookmarks: updatedBookmarks },
		});

		editor.scenes.setScenes({ scenes: updatedScenes });
		this.appliedScenes = updatedScenes;
	}

	redo(): CommandResult | undefined {
		// Redo follows the undo of this command, so the timeline is as it was when this command first ran.
		if (!this.appliedScenes) return this.execute();
		EditorCore.getInstance().scenes.setScenes({ scenes: this.appliedScenes });
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			const editor = EditorCore.getInstance();
			editor.scenes.setScenes({ scenes: this.savedScenes });
		}
	}
}
