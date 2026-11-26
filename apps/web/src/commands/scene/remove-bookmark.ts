import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Bookmark, TScene } from "@/timeline";
import { updateSceneInArray } from "@/timeline/scenes";
import {
	getFrameTime,
	removeBookmarkFromArray,
} from "@/timeline/bookmarks/index";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export class RemoveBookmarkCommand extends Command {
	private savedScenes: TScene[] | null = null;
	/** The scenes this command produced, so Redo restores them even when the bookmark object it addressed was replaced. */
	private appliedScenes: TScene[] | null = null;
	private frameTime: MediaTime = ZERO_MEDIA_TIME;

	constructor(private time: MediaTime, private bookmark?: Bookmark) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeScene = editor.scenes.getActiveScene();
		const activeProject = editor.project.getActive();

		if (!activeScene || !activeProject) {
			return;
		}

		const scenes = editor.scenes.getScenes();
		this.savedScenes = [...scenes];

		this.frameTime = getFrameTime({
			time: this.time,
			fps: activeProject.settings.fps,
		});

		const updatedBookmarks = removeBookmarkFromArray({
			bookmarks: activeScene.bookmarks,
			frameTime: this.frameTime,
			bookmark: this.bookmark,
		});

		if (updatedBookmarks.length === activeScene.bookmarks.length) {
			return { changed: false };
		}

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
