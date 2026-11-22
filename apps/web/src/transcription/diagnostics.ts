import type { DiagnosticsManager } from "@/core/managers/diagnostics-manager";
import { timelineHasAudio } from "@/media/audio";

export const TRANSCRIPTION_DIAGNOSTICS_SCOPE = "transcription";
export const TRANSCRIPTION_NO_AUDIO = "transcription.no_audio";

export function registerTranscriptionDiagnostics({
	diagnostics,
}: {
	diagnostics: DiagnosticsManager;
}): void {
	diagnostics.register({
		id: TRANSCRIPTION_NO_AUDIO,
		scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE,
		severity: "caution",
		message: "No audio detected. Add a clip with audio to the timeline first.",
		check: (editor) => {
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!scene) return false;
			return !timelineHasAudio({
				tracks: scene.tracks,
				mediaAssets: editor.media.getAssets(),
				scenes: editor.scenes.getScenes(),
			});
		},
	});
}
