import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Bookmark, TScene } from "@/timeline";
import { updateSceneInArray } from "@/timeline/scenes";
import {
	getFrameTime,
	updateBookmarkInArray,
} from "@/timeline/bookmarks/index";
import type { MediaTime } from "@/wasm";

export class UpdateBookmarkCommand extends Command {
	private savedScenes: TScene[] | null = null;
	/** The scenes this command produced, so Redo restores them even when the bookmark object it addressed was replaced. */
	private appliedScenes: TScene[] | null = null;

	constructor({
		time,
		updates,
		create = false,
		bookmark,
	}: {
		time: MediaTime;
		updates: Partial<Omit<Bookmark, "time">>;
		create?: boolean;
		bookmark?: Bookmark;
	}) {
		super();
		this.time = time;
		this.updates = updates;
		this.create = create;
		this.bookmark = bookmark;
	}

	private time: MediaTime;
	private updates: Partial<Omit<Bookmark, "time">>;
	private create: boolean;
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

		const frameTime = getFrameTime({
			time: this.time,
			fps: activeProject.settings.fps,
		});

		let updatedBookmarks = updateBookmarkInArray({
			bookmarks: activeScene.bookmarks,
			frameTime,
			updates: this.updates,
			bookmark: this.bookmark,
		});
		if (updatedBookmarks === activeScene.bookmarks) {
			if (!this.create || this.bookmark) return { changed: false };
			updatedBookmarks = [...updatedBookmarks, { ...this.updates, time: frameTime }].sort((a, b) => a.time - b.time);
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
