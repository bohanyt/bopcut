import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { STICKER_INTRINSIC_SIZE_FALLBACK } from "@/stickers/intrinsic-size";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import { getTextMeasurementContext, measureTextElement } from "@/text/measure-element";
import {
	getElementLocalTime,
} from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";

function sharedTextContext() {
	try {
		return getTextMeasurementContext();
	} catch {
		return null;
	}
}

export interface ElementBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface ElementWithBounds {
	trackId: string;
	elementId: string;
	element: TimelineElement;
	bounds: ElementBounds;
}

function getVisualElementBounds({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scaleX;
	const scaledHeight = sourceHeight * containScale * transform.scaleY;
	const cx = canvasWidth / 2 + transform.position.x;
	const cy = canvasHeight / 2 + transform.position.y;

	return {
		cx,
		cy,
		width: scaledWidth,
		height: scaledHeight,
		rotation: transform.rotate,
	};
}

function getTransformedRectBounds({
	canvasWidth,
	canvasHeight,
	rect,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	rect: { left: number; top: number; width: number; height: number };
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const localCenterX = rect.left + rect.width / 2;
	const localCenterY = rect.top + rect.height / 2;
	const scaledCenterX = localCenterX * transform.scaleX;
	const scaledCenterY = localCenterY * transform.scaleY;
	const rotationRad = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);
	return {
		cx:
			canvasWidth / 2 +
			transform.position.x +
			scaledCenterX * cos -
			scaledCenterY * sin,
		cy:
			canvasHeight / 2 +
			transform.position.y +
			scaledCenterX * sin +
			scaledCenterY * cos,
		width: rect.width * transform.scaleX,
		height: rect.height * transform.scaleY,
		rotation: transform.rotate,
	};
}

/**
 * Bounds policy: bounds reflect base content geometry (text glyphs + background,
 * sticker/image/video content area) and base transform. Post-effect spill (blur,
 * glow) and mask-clipped regions are intentionally excluded — handles manipulate
 * the canonical element geometry, not visual effect output.
 */
export function getElementBounds({
	element,
	canvasSize,
	mediaAsset,
	localTime,
	includeCompound,
	textContext,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	mediaAsset?: Pick<MediaAsset, "width" | "height"> | null;
	localTime: number;
	includeCompound?: boolean;
	textContext?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): ElementBounds | null {
	if (element.type === "audio" || element.type === "effect") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;

	if (includeCompound && element.type === "compound") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }), animations: element.animations, localTime,
		});
		return getVisualElementBounds({ canvasWidth, canvasHeight, sourceWidth: canvasWidth, sourceHeight: canvasHeight, transform });
	}
	if (element.type === "video" || element.type === "image") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		const sourceWidth = mediaAsset?.width ?? canvasWidth;
		const sourceHeight = mediaAsset?.height ?? canvasHeight;
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	}

	if (element.type === "sticker") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: element.intrinsicWidth ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			sourceHeight: element.intrinsicHeight ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			transform,
		});
	}

	if (element.type === "graphic") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
			sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
			transform,
		});
	}

	if (element.type === "text") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});

		// The shared measuring context: bounds are read on every playback tick and drag move.
		const ctx = textContext ?? sharedTextContext();
		if (!ctx) return null;

		const measured = measureTextElement({
			element,
			canvasHeight,
			localTime,
			ctx,
		});

		// A text with no characters has no width: keep it as wide as a line is tall, so it can
		// still be clicked and double-clicked to type again.
		const rect = measured.visualRect;
		const width = Math.max(rect.width, rect.height);
		return getTransformedRectBounds({
			canvasWidth,
			canvasHeight,
			rect: { ...rect, left: rect.left - (width - rect.width) / 2, width },
			transform,
		});
	}

	return null;
}

export const ROTATION_HANDLE_OFFSET = 24;

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Edge = "right" | "left" | "bottom";

export function getCornerPosition({
	bounds,
	corner,
}: {
	bounds: ElementBounds;
	corner: Corner;
}): { x: number; y: number } {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfW : halfW;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfH : halfH;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getEdgeHandlePosition({
	bounds,
	edge,
}: {
	bounds: ElementBounds;
	edge: Edge;
}): { x: number; y: number } {
	const halfWidth = bounds.width / 2;
	const halfHeight = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX = edge === "right" ? halfWidth : edge === "left" ? -halfWidth : 0;
	const localY = edge === "bottom" ? halfHeight : 0;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getVisibleElementsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	mediaAssets,
	onlyElements,
	includeCompound,
}: {
	tracks: SceneTracks;
	currentTime: number;
	canvasSize: { width: number; height: number };
	mediaAssets: MediaAsset[];
	onlyElements?: readonly ElementRef[];
	includeCompound?: boolean;
}): ElementWithBounds[] {
	const mediaMap = onlyElements ? null : new Map(mediaAssets.map((m) => [m.id, m]));
	const orderedTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	].reverse();

	const result: ElementWithBounds[] = [];

	for (const track of orderedTracks) {
		const elementIds = onlyElements && new Set(
			onlyElements.filter((ref) => ref.trackId === track.id).map((ref) => ref.elementId),
		);
		if (elementIds?.size === 0) continue;
		const elements = track.elements
			.filter(
				(element) =>
					(!elementIds || elementIds.has(element.id)) &&
					!("hidden" in element && element.hidden),
			)
			.filter(
				(element) =>
					currentTime >= element.startTime &&
					currentTime < element.startTime + element.duration,
			)
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const element of elements) {
			const localTime = getElementLocalTime({
				timelineTime: currentTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			});
			const mediaAsset =
				element.type === "video" || element.type === "image"
					? mediaMap
						? mediaMap.get(element.mediaId)
						: mediaAssets.find((asset) => asset.id === element.mediaId)
					: undefined;
			const bounds = getElementBounds({
				element,
				canvasSize,
				mediaAsset,
				localTime,
				includeCompound,
			});
			if (bounds) {
				result.push({
					trackId: track.id,
					elementId: element.id,
					element,
					bounds,
				});
			}
		}
	}

	return result;
}
