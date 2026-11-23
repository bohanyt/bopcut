import { readPresetSettings } from "@/animation/presets";
import type { CompoundElement, ImageElement, SceneTracks, TScene, TimelineTrack, VideoElement } from "@/timeline";
import { readShakeSettings } from "@/rendering/shake";
import {
	CompoundCycleError,
	expandCompoundMainTrackMedia,
} from "@/timeline/compound";
import { CompoundNode } from "./nodes/compound-node";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { Model3dNode } from "./nodes/model3d-node";
import { isModelFile } from "@/media/media-utils";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode, preloadStickerSource } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleElements(track: TimelineTrack) {
	return track.elements.filter((element) => !("hidden" in element && element.hidden));
}

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return getVisibleElements(track)
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

type BuildContext = {
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	scenes: TScene[];
	/** Compound scenes being built above this level; guards against cycles. */
	sceneStack: string[];
};

function getVisualTracksBottomToTop(tracks: SceneTracks): TimelineTrack[] {
	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	return visibleTracks.slice().reverse();
}

/** The visual media intersecting the export window, in each compound's local time. */
export function collectVisibleMedia({ tracks, scenes, duration }: {
	tracks: SceneTracks;
	scenes: TScene[];
	duration: number;
}): (VideoElement | ImageElement)[] {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	const media: (VideoElement | ImageElement)[] = [];
	const stack = new Set<string>();

	function visit(tracks: SceneTracks, start: number, end: number) {
		for (const track of getVisualTracksBottomToTop(tracks)) {
			for (const element of getVisibleElements(track)) {
				const from = Math.max(start, element.startTime);
				const to = Math.min(end, element.startTime + element.duration);
				if (from >= to) continue;
				if (element.type === "video" || element.type === "image") {
					media.push(element);
				} else if (element.type === "compound") {
					const nested = byId.get(element.sceneId);
					if (!nested || stack.has(nested.id)) continue;
					const offset = element.trimStart - element.startTime;
					stack.add(nested.id);
					visit(nested.tracks, from + offset, to + offset);
					stack.delete(nested.id);
				}
			}
		}
	}

	visit(tracks, 0, duration);
	return media;
}

function buildCompoundNode({
	element,
	context,
}: {
	element: CompoundElement;
	context: BuildContext;
}): CompoundNode | null {
	const scene = context.scenes.find((s) => s.id === element.sceneId);
	if (!scene) return null;
	if (context.sceneStack.includes(scene.id)) {
		console.warn(new CompoundCycleError(scene.id).message);
		return null;
	}

	const content = new RootNode(
		{ duration: element.sourceDuration ?? element.duration },
		buildTrackNodes({
			tracks: getVisualTracksBottomToTop(scene.tracks),
			context: { ...context, sceneStack: [...context.sceneStack, scene.id] },
		}),
	);

	return new CompoundNode({
		content,
		duration: element.duration,
		timeOffset: element.startTime,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		transform: buildTransformFromParams({ params: element.params }),
		shake: readShakeSettings(element.params),
		presets: readPresetSettings(element.params),
		animations: element.animations,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
	});
}

function buildTrackNodes({
	tracks,
	context,
}: {
	tracks: TimelineTrack[];
	context: BuildContext;
}): AnyBaseNode[] {
	const { mediaMap, canvasSize, isPreview } = context;
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });

		for (const element of elements) {
			if (element.type === "compound") {
				const node = buildCompoundNode({ element, context });
				if (node) nodes.push(node);
				continue;
			}

			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset?.file || !mediaAsset?.url) {
					continue;
				}

				if (element.type === "video" && mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							file: mediaAsset.file,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							transform: buildTransformFromParams({ params: element.params }),
							shake: readShakeSettings(element.params),
							presets: readPresetSettings(element.params),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
						}),
					);
				}
				if (element.type === "image" && mediaAsset.type === "image" && isModelFile(mediaAsset.file)) {
					nodes.push(new Model3dNode({
						mediaId: mediaAsset.id, file: mediaAsset.file, params: element.params,
						duration: element.duration, timeOffset: element.startTime,
						trimStart: element.trimStart, trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						shake: readShakeSettings(element.params),
						presets: readPresetSettings(element.params),
						animations: element.animations, opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [], masks: element.masks ?? [],
					}));
				} else if (element.type === "image" && mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							shake: readShakeSettings(element.params),
							presets: readPresetSettings(element.params),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						shake: readShakeSettings(element.params),
						presets: readPresetSettings(element.params),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						shake: readShakeSettings(element.params),
						presets: readPresetSettings(element.params),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
	scenes,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
	scenes: TScene[];
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	// A compound clip on the main track blurs the media of its nested main track.
	const elements = expandCompoundMainTrackMedia({
		elements: getVisibleSortedElements({ track }),
		scenes,
	});

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
	/** All project scenes, so compound clips can find their nested scene. */
	scenes?: TScene[];
};

/** Start sticker loads before playback can reach them, once per installed preview tree. */
export function preloadPreviewStickers(root: RootNode): void {
	for (const child of root.children) {
		if (child instanceof CompoundNode) {
			preloadPreviewStickers(child.params.content);
		} else if (child instanceof StickerNode) {
			preloadStickerSource(child.params.stickerId);
		}
	}
}

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	scenes = [],
}: BuildSceneParams) {
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: getVisualTracksBottomToTop(tracks),
		context: { mediaMap, canvasSize, isPreview, scenes, sceneStack: [] },
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
			scenes,
		});
		return new RootNode({ duration }, [...blurNodes, ...allNodes]);
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		return new RootNode({ duration }, [new ColorNode({ color: background.color }), ...allNodes]);
	}

	return new RootNode({ duration }, allNodes);
}
