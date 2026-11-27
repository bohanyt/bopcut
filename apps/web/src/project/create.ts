import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import type { ProjectMode, TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import { getBrowserTranslator } from "@/i18n/browser";

export function buildNewProject({ name, mode }: { name: string; mode?: ProjectMode }): TProject {
	const mainScene = buildDefaultScene({ name: getBrowserTranslator()("timeline.mainSceneName"), isMain: true });
	return {
		metadata: {
			id: generateUUID(),
			name,
			...(mode && { mode }),
			duration: getProjectDurationFromScenes({ scenes: [mainScene] }),
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [mainScene],
		currentSceneId: mainScene.id,
		settings: {
			fps: DEFAULT_FPS,
			canvasSize: DEFAULT_CANVAS_SIZE,
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: DEFAULT_BACKGROUND_COLOR },
		},
		version: CURRENT_PROJECT_VERSION,
	};
}
