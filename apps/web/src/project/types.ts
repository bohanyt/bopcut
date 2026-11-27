import type { FrameRate } from "opencut-wasm";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

/** What a project is for. It directs the agents that work on it (AGENT.md, *Work modes*). */
export const PROJECT_MODES = ["editing", "creating", "generating"] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];
export const isProjectMode = (value: unknown): value is ProjectMode =>
	PROJECT_MODES.includes(value as ProjectMode);

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	/** Unset on projects made before modes, and when the person leaves it open. */
	mode?: ProjectMode;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
