import { NO_PRESET_LAYER, type PresetLayer, presetLayerAt, readPresetSettings } from "@/animation/presets";
import { TICKS_PER_SECOND, mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { getElementLocalTime } from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import type { Effect, EffectPass } from "@/effects/types";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type { Transform } from "@/rendering";
import { applyShake, readShakeSettings } from "@/rendering/shake";
import { waitWithAbort } from "@/utils/abort";
import type { CanvasRenderer } from "./canvas-renderer";
import { proxyTime, type ProxyInfo } from "@/services/proxies/mapping";
import type { AnyBaseNode } from "./nodes/base-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { Model3dNode } from "./nodes/model3d-node";
import { CompoundNode } from "./nodes/compound-node";
import { renderModel3d } from "@/model3d/render";
import { model3dParams } from "@/params/registry";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { getRendererLimits } from "./renderer-device";
import { StickerNode, loadStickerSource } from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";

type ResolveContext = {
	renderer: CanvasRenderer;
	time: number;
	signal?: AbortSignal;
	proxies?: ReadonlyMap<string, { info: ProxyInfo; file: File }>;
};

export function visibleVideoNodes(root: AnyBaseNode, time: number): Set<AnyBaseNode> {
	const result = new Set<AnyBaseNode>();
	function visit(node: AnyBaseNode, at: number) {
		if (node instanceof CompoundNode || node instanceof VideoNode ||
			(node instanceof BlurBackgroundNode && node.params.mediaType === "video")) {
			const { timeOffset, duration } = node.params;
			if (at < timeOffset || at >= timeOffset + duration) return;
			if (node instanceof CompoundNode) {
				visit(node.params.content, at - timeOffset + node.params.trimStart);
				return;
			}
			result.add(node);
		}
		for (const child of node.children) visit(child, at);
	}
	visit(root, time);
	return result;
}

export async function resolveRenderTree({
	node,
	renderer,
	time,
	signal,
	proxies,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	time: number;
	signal?: AbortSignal;
	proxies?: ResolveContext["proxies"];
}): Promise<void> {
	await resolveNode({ node, context: { renderer, time, signal, proxies } });
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	context.signal?.throwIfAborted();
	if (node instanceof CompoundNode) {
		await resolveCompoundNode({ node, context });
		return;
	}

	if (node instanceof VideoNode) {
		node.resolved = await resolveVideoNode({ node, context });
	} else if (node instanceof Model3dNode) {
		node.resolved = await resolveModel3dNode({ node, context });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}

	const pending: Promise<void>[] = [];
	for (const child of node.children) {
		// A caption track can contain hundreds of phrases, but only the visible ones
		// need asynchronous traversal. Clear the previous frame before skipping it.
		if (
			child instanceof TextNode &&
			(context.time < child.params.startTime ||
				context.time >= child.params.startTime + child.params.duration)
		) {
			child.resolved = null;
			continue;
		}
		pending.push(resolveNode({ node: child, context }));
	}
	if (!pending.length) return;
	// Finish all reads before the renderer can recycle frame surfaces, even when one fails.
	const results = await Promise.allSettled(pending);
	for (const result of results) {
		if (result.status === "rejected") throw result.reason;
	}
}

function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	width: number;
	height: number;
}): EffectPass[][] {
	return (effects ?? [])
		.filter((effect) => effect.enabled)
		.map((effect) => {
			const resolvedParams = resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime,
			});
			const definition = effectsRegistry.get(effect.type);
			return resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
			});
		})
		// An effect that changes nothing right now (for example a blur of 0) has no passes; the GPU
		// compositor refuses an empty group.
		.filter((passes) => passes.length > 0);
}

function resolveVisualState({
	params,
	context,
	sourceWidth,
	sourceHeight,
	placement = resolveVisualPlacement(params, context),
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	sourceWidth: number;
	sourceHeight: number;
	placement?: ReturnType<typeof resolveVisualPlacement>;
}): ResolvedVisualNodeState | null {
	if (!placement) return null;
	const { localTime, preset, transform } = placement;
	const opacity =
		resolveOpacityAtTime({
			baseOpacity: params.opacity,
			animations: params.animations,
			localTime,
		}) * preset.opacity;
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
	);
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);

	const passWidth = Math.max(1, Math.round(effectWidth * context.renderer.renderScale));
	const passHeight = Math.max(1, Math.round(effectHeight * context.renderer.renderScale));
	return {
		localTime,
		transform,
		opacity,
		effectPasses: withPresetBlur(
			resolveEffectPassGroups({
				effects: params.effects,
				animations: params.animations,
				localTime,
				width: passWidth,
				height: passHeight,
			}),
			preset,
			passWidth,
			passHeight,
		),
	};
}

function resolveVisualPlacement(params: VisualNodeParams, context: ResolveContext) {
	const clipTime = context.time - params.timeOffset;
	if (clipTime < 0 || clipTime >= params.duration) return null;

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const preset = params.presets ? presetLayerAt(params.presets, localTime, params.duration, context.renderer.height) : NO_PRESET_LAYER;
	const transform = withPresetLayer(
		applyShake({
			transform: resolveTransformAtTime({
				baseTransform: params.transform,
				animations: params.animations,
				localTime,
			}),
			settings: params.shake,
			animations: params.animations,
			localTime,
			ticksPerSecond: TICKS_PER_SECOND,
		}),
		preset,
	);
	return { localTime, preset, transform };
}

/** The transform with an animation preset's scale, drop and tilt on top. */
function withPresetLayer(transform: Transform, preset: PresetLayer): Transform {
	if (preset === NO_PRESET_LAYER) return transform;
	return {
		...transform,
		position: { ...transform.position, y: transform.position.y + preset.offsetY },
		scaleX: transform.scaleX * preset.scale,
		scaleY: transform.scaleY * preset.scale,
		rotate: transform.rotate + preset.rotate,
	};
}

/** The clip's effect pass groups and an animation preset's blur after them (the same array while it blurs nothing). */
function withPresetBlur(groups: EffectPass[][], preset: PresetLayer, width: number, height: number): EffectPass[][] {
	if (preset.blur <= 0) return groups;
	const passes = buildGaussianBlurPasses({
		sigmaX: intensityToSigma({ intensity: preset.blur, resolution: width, reference: 1920 }),
		sigmaY: intensityToSigma({ intensity: preset.blur, resolution: height, reference: 1080 }),
	});
	return passes.length ? [...groups, passes] : groups;
}

function clearCompoundVideoFrames(node: AnyBaseNode): void {
	if (node instanceof VideoNode || (node instanceof BlurBackgroundNode && node.params.mediaType === "video")) {
		node.resolved = null;
	}
	if (node instanceof CompoundNode && node.resolved) {
		node.resolved = null;
		clearCompoundVideoFrames(node.params.content);
	}
	for (const child of node.children) clearCompoundVideoFrames(child);
}

// The nested scene is resolved at its own local time: t - startTime + trimStart.
async function resolveCompoundNode({
	node,
	context,
}: {
	node: CompoundNode;
	context: ResolveContext;
}): Promise<void> {
	const wasVisible = node.resolved !== null;
	node.resolved = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: context.renderer.width,
		sourceHeight: context.renderer.height,
	});
	if (!node.resolved) {
		if (wasVisible) clearCompoundVideoFrames(node.params.content);
		return;
	}

	await resolveNode({
		node: node.params.content,
		context: {
			...context,
			time: context.time - node.params.timeOffset + node.params.trimStart,
		},
	});
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<VideoNode["resolved"]> {
	const placement = resolveVisualPlacement(node.params, context);
	if (!placement) return null;

	const sourceTimeTicks =
		node.params.trimStart +
		getSourceTimeAtClipTime({
			clipTime: context.time - node.params.timeOffset,
			retime: node.params.retime,
		});
	const { width, height, outputWidth, outputHeight } = context.renderer;
	const { scaleX, scaleY } = placement.transform;
	const frame = await readVideoFrame(node.params, sourceTimeTicks, context, (source) => {
		const containScale = Math.min(width / source.width, height / source.height);
		return containScale * Math.max(
			(Math.abs(scaleX) * outputWidth) / width,
			(Math.abs(scaleY) * outputHeight) / height,
		);
	});
	if (!frame) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: frame.sourceWidth,
		sourceHeight: frame.sourceHeight,
		placement,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: frame.canvas,
		sourceWidth: frame.sourceWidth,
		sourceHeight: frame.sourceHeight,
		sourceVersion: frame.timestamp,
	};
}

function readVideoFrame(
	{ mediaId, file }: { mediaId: string; file: File },
	time: number,
	context: ResolveContext,
	getScale: (source: { width: number; height: number }) => number,
) {
	const seconds = mediaTimeToSeconds({ time: roundMediaTime({ time }) });
	const readOriginal = () => context.renderer.videoCache.getFrameAt({
		file,
		time: seconds,
		getScale: context.renderer.exactFrames ? undefined : getScale,
		maxTextureDimension: getRendererLimits().maxTextureDimension,
		throwOnSeekError: context.renderer.strictVideoDecoding,
		signal: context.signal,
	});
	const candidate = context.proxies?.get(mediaId);
	if (!candidate || candidate.file !== file) return readMediaSource(mediaId, context, readOriginal);
	return readMediaSource(mediaId, context, async () => {
		const info = candidate.info;
		const mapped = proxyTime(info, seconds);
		if (mapped !== undefined) {
			try {
				const frame = await context.renderer.videoCache.getFrameAt({
					file: new URL("/api/proxies?key=" + info.key, location.origin).href,
					time: mapped, maxTextureDimension: getRendererLimits().maxTextureDimension,
					signal: context.signal,
				});
				if (frame) return { ...frame, sourceWidth: info.width, sourceHeight: info.height };
			} catch { context.signal?.throwIfAborted(); }
		}
		return readOriginal();
	});
}

async function readMediaSource<T>(
	mediaId: string,
	{ renderer, signal }: ResolveContext,
	read: () => Promise<T>,
): Promise<T | null> {
	if (renderer.failedMediaIds.has(mediaId)) return null;
	signal?.throwIfAborted();
	try {
		return await waitWithAbort(read(), signal);
	} catch (error) {
		signal?.throwIfAborted();
		if (!renderer.onMediaFailure) throw error;
		if (renderer.failedMediaIds.has(mediaId)) return null;
		renderer.failedMediaIds.add(mediaId);
		renderer.onMediaFailure(mediaId, error);
		return null;
	}
}

// Render 3D models at 1024 px to stay sharp when enlarged nearly fullscreen.
const MODEL3D_SOURCE_SIZE = 1024;

async function resolveModel3dNode({ node, context }: { node: Model3dNode; context: ResolveContext }): Promise<ResolvedVisualSourceNodeState | null> {
	const size = Math.max(1, Math.round(MODEL3D_SOURCE_SIZE * context.renderer.renderScale));
	const visualState = resolveVisualState({ params: node.params, context, sourceWidth: size, sourceHeight: size });
	if (!visualState) return null;
	const params = { ...node.params.params };
	for (const definition of model3dParams) {
		params[definition.key] = resolveAnimationPathValueAtTime({ animations: node.params.animations, propertyPath: definition.key, localTime: visualState.localTime, fallbackValue: params[definition.key] ?? definition.default });
	}
	const source = await waitWithAbort(
		renderModel3d({ id: node.params.mediaId, file: node.params.file, params, size, signal: context.signal }),
		context.signal,
	);
	return { ...visualState, source, sourceWidth: size, sourceHeight: size };
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ImageNode["resolved"]> {
	const { mediaId, url, maxSourceSize, timeOffset, duration } = node.params;
	if (context.time < timeOffset || context.time >= timeOffset + duration) return null;

	const deviceLimit = getRendererLimits().maxTextureDimension;
	const source = await readMediaSource(mediaId, context, () => loadImageSource({
		url,
		maxSourceSize: deviceLimit === undefined ? maxSourceSize : Math.min(maxSourceSize ?? Infinity, deviceLimit),
	}));
	if (!source) return null;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: source.naturalWidth,
		sourceHeight: source.naturalHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth: source.naturalWidth,
		sourceHeight: source.naturalHeight,
	};
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await waitWithAbort(loadStickerSource({ stickerId: node.params.stickerId }), context.signal);
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): ResolvedGraphicNodeState | null {
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
		sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		resolvedParams: resolveGraphicElementParamsAtTime({
			element: node.params,
			localTime: visualState.localTime,
		}),
	};
}

function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): ResolvedTextNodeState | null {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });
	const preset = presetLayerAt(readPresetSettings(node.params.params), localTime, node.params.duration, context.renderer.height);

	return {
		transform: withPresetLayer(
			applyShake({
				transform: resolveTransformAtTime({
					baseTransform: node.params.transform,
					animations: node.params.animations,
					localTime,
				}),
				settings: readShakeSettings(node.params.params),
				animations: node.params.animations,
				localTime,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
			preset,
		),
		opacity:
			resolveOpacityAtTime({
				baseOpacity: node.params.opacity,
				animations: node.params.animations,
				localTime,
			}) * preset.opacity,
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		effectPasses: withPresetBlur(
			resolveEffectPassGroups({
				effects: node.params.effects,
				animations: node.params.animations,
				localTime,
				width: context.renderer.outputWidth,
				height: context.renderer.outputHeight,
			}),
			preset,
			context.renderer.outputWidth,
			context.renderer.outputHeight,
		),
		measuredText: measureTextElement({
			element: node.params,
			canvasHeight: node.params.canvasHeight,
			localTime,
			ctx: getTextMeasurementContext(),
			presetTyped: preset.typed,
		}),
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const backdropSource = await resolveBackdropSource({ node, clipTime, context });
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.outputWidth,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.outputHeight,
				reference: 1080,
			}),
		}),
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
	context,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
	context: ResolveContext;
}): Promise<BackdropSource | null> {
	if (node.params.mediaType === "video") {
		const sourceTimeTicks =
			node.params.trimStart +
			getSourceTimeAtClipTime({
				clipTime,
				retime: node.params.retime,
			});
		const { outputWidth, outputHeight } = context.renderer;
		const frame = await readVideoFrame(node.params, sourceTimeTicks, context, ({ width, height }) =>
			Math.max(outputWidth / width, outputHeight / height),
		);
		if (!frame) {
			return null;
		}

		return {
			source: frame.canvas,
			width: frame.sourceWidth,
			height: frame.sourceHeight,
			version: frame.timestamp,
		};
	}

	const { mediaId, url } = node.params;
	const source = await readMediaSource(mediaId, context, () => loadImageSource({
		url, maxSourceSize: getRendererLimits().maxTextureDimension,
	}));
	if (!source) return null;
	return {
		source: source.source,
		width: source.naturalWidth,
		height: source.naturalHeight,
	};
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const definition = effectsRegistry.get(node.params.effectType);
	const passes = resolveEffectPasses({
		definition,
		effectParams: node.params.effectParams,
		width: context.renderer.outputWidth,
		height: context.renderer.outputHeight,
	});
	if (passes.length === 0) {
		return null;
	}

	return {
		passes,
	};
}
