import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import type { TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";

export function buildNewProject({ name }: { name: string }): TProject {
	const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
	return {
		metadata: {
			id: generateUUID(),
			name,
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
