import { BatchCommand } from "@/commands/batch-command";
import type { Command } from "@/commands/base-command";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { getBrowserTranslator } from "@/i18n/browser";
import type { ElementRef } from "@/timeline/types";
import { buildSplitLayout, type SourceRect } from "./split-layout";

/** The vertical canvas the layout is made for when the project is still landscape. */
export const VERTICAL_CANVAS = { width: 1080, height: 1920 } as const;

/**
 * Applies the split layout to a clip of the open scene in one Undo step, making the canvas vertical
 * first when it is not. Returns the facecam copy, or null when the clip cannot be split.
 */
export function applySplitLayout(editor: EditorCore, { clip, facecam, split }: { clip: ElementRef; facecam: SourceRect; split?: number }): ElementRef | null {
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!project || !scene) return null;
	const element = editor.timeline.getElementsWithTracks({ elements: [clip] })[0]?.element;
	if (element?.type !== "video") return null;
	const asset = editor.media.getAssets().find(({ id }) => id === element.mediaId);
	if (!asset?.width || !asset.height) return null;

	const current = project.settings.canvasSize;
	const canvas = current.height > current.width ? current : VERTICAL_CANVAS;
	const t = getBrowserTranslator();
	const layout = buildSplitLayout({
		tracks: scene.tracks, clip, facecam, split,
		media: { width: asset.width, height: asset.height }, canvas,
		names: { facecamTrack: t("reframe.facecamTrack"), facecamClip: (name) => t("reframe.facecamClip", { name }) },
	});
	if (!layout) return null;

	const commands: Command[] = [];
	if (canvas !== current) commands.push(new UpdateProjectSettingsCommand({ canvasSize: { ...canvas }, canvasSizeMode: "preset" }));
	commands.push(new TracksSnapshotCommand({ before: scene.tracks, after: layout.tracks, selectedElements: [layout.facecam], ripples: false }));
	editor.command.execute({ command: commands.length === 1 ? commands[0] : new BatchCommand(commands) });
	return layout.facecam;
}
