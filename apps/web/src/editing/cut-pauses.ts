import { AgentDraftCommand } from "@/agent/draft-command";
import { computeAgentDraft } from "@/agent/draft";
import { timelineTranscript } from "@/agent/packed-transcript";
import { getRootScene } from "@/agent/scene-graph";
import { DEFAULT_SILENCE_OPTIONS, planSilenceCuts, type SilenceOptions } from "@/agent/silence-plan";
import type { EditorCore } from "@/core";
import { frameRateToFloat } from "@/fps/utils";
import { calculateTotalDuration } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";

export type PausePlan = ReturnType<typeof planSilenceCuts> & { rootSceneId: string };

export { DEFAULT_SILENCE_OPTIONS as DEFAULT_PAUSE_OPTIONS };

/**
 * The cuts that would take dead air and filler sounds out of the open timeline (its root, also while
 * a compound is open), from the words stored with its media: the same plan as the agent's
 * `silence-plan`. Clips that play sound without stored words block cuts over their time.
 */
export function planPauseCuts(editor: EditorCore, options: SilenceOptions = DEFAULT_SILENCE_OPTIONS): PausePlan | null {
	const project = editor.project.getActiveOrNull();
	const scenes = editor.scenes.getScenes();
	const root = getRootScene(scenes, editor.scenes.getActiveSceneOrNull()?.id ?? null);
	if (!project || !root) return null;
	const media = editor.media.getAssets().map(({ id, name, duration, hasAudio, words }) => ({ id, name, duration, hasAudio, words }));
	const plan = planSilenceCuts({
		clips: timelineTranscript(root, scenes, media, { groupWords: false }),
		duration: calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND,
		fps: frameRateToFloat(project.settings.fps),
		options,
	});
	return { ...plan, rootSceneId: root.id };
}

/** Applies a pause plan as one Undo step; false when nothing could be cut (the timeline changed since). */
export function applyPauseCuts(editor: EditorCore, plan: PausePlan): boolean {
	const project = editor.project.getActiveOrNull();
	if (!project || !plan.ops.length) return false;
	const before = editor.scenes.getScenes();
	const outcome = computeAgentDraft({
		scenes: before, rootSceneId: plan.rootSceneId, ops: plan.ops, mediaFor: () => undefined, atomic: true,
		canvas: project.settings.canvasSize, fps: project.settings.fps, ripple: false,
	});
	if (!outcome.applied) return false;
	const open = editor.scenes.getActiveSceneOrNull()?.id ?? plan.rootSceneId;
	const command = new AgentDraftCommand({ before, after: outcome.scenes, selection: [], openBefore: open, openAfter: open });
	if (!command.getChangedSceneIds().length) return false;
	editor.command.execute({ command });
	return true;
}
