import { createCanvasSurface } from "../canvas-utils";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	getGraphicDefinition,
	registerDefaultGraphics,
} from "@/graphics";
import type { ParamValues } from "@/params";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface GraphicNodeParams extends VisualNodeParams {
	definitionId: string;
	params: ParamValues;
}

export interface ResolvedGraphicNodeState extends ResolvedVisualNodeState {
	resolvedParams: ParamValues;
}

export class GraphicNode extends VisualNode<
	GraphicNodeParams,
	ResolvedGraphicNodeState
> {
	private cachedKey: string | null = null;
	private cachedSource: OffscreenCanvas | null = null;
	private cachedSvg: unknown = undefined;

	constructor(params: GraphicNodeParams) {
		super(params);
		registerDefaultGraphics();
	}

	getSource({
		resolvedParams,
		width = DEFAULT_GRAPHIC_SOURCE_SIZE,
		height = DEFAULT_GRAPHIC_SOURCE_SIZE,
		logicalWidth = width,
		logicalHeight = height,
	}: {
		resolvedParams: ParamValues;
		width?: number;
		height?: number;
		logicalWidth?: number;
		logicalHeight?: number;
	}): OffscreenCanvas {
		const definition = getGraphicDefinition({
			definitionId: this.params.definitionId,
		});
		// An icon's SVG text can be kilobytes: it is compared as it is, not copied into the key on every frame.
		const { svg, ...keyedParams } = resolvedParams;
		const cacheKey = JSON.stringify({
			definitionId: this.params.definitionId,
			params: keyedParams,
			width,
			height,
			logicalWidth,
			logicalHeight,
		});
		if (this.cachedSource && this.cachedKey === cacheKey && this.cachedSvg === svg) {
			return this.cachedSource;
		}

		const { canvas, context } = createCanvasSurface({
			width,
			height,
		});

		context.scale(width / logicalWidth, height / logicalHeight);
		definition.render({
			ctx: context,
			params: resolvedParams,
			width: logicalWidth,
			height: logicalHeight,
		});

		this.cachedKey = cacheKey;
		this.cachedSvg = svg;
		this.cachedSource = canvas;
		return canvas;
	}
}
