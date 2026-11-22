import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import { fitSurfaceSize } from "../scale";

export interface ImageNodeParams extends VisualNodeParams {
	mediaId: string;
	url: string;
	maxSourceSize?: number;
}

export interface CachedImageSource {
	source: HTMLImageElement | OffscreenCanvas;
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
}

const imageSourceCache = new Map<string, Promise<CachedImageSource>>();

export function loadImageSource({
	url,
	maxSourceSize,
}: {
	url: string;
	maxSourceSize?: number;
}): Promise<CachedImageSource> {
	const cacheKey = `${url}::${maxSourceSize ?? "full"}`;

	const cached = imageSourceCache.get(cacheKey);
	if (cached) return cached;

	const promise = (async (): Promise<CachedImageSource> => {
		const image = new Image();

		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("Image load failed"));
			image.src = url;
		});

		const naturalWidth = image.naturalWidth;
		const naturalHeight = image.naturalHeight;
		if (!naturalWidth || !naturalHeight) throw new Error("Image has no drawable dimensions");
		const { width, height } = fitSurfaceSize(naturalWidth, naturalHeight, maxSourceSize ?? Infinity);
		if (width !== naturalWidth || height !== naturalHeight) {
			const offscreen = new OffscreenCanvas(width, height);
			const ctx = offscreen.getContext("2d");
			if (!ctx) throw new Error("Failed to create a canvas for resizing the image");
			ctx.drawImage(image, 0, 0, width, height);
			return { source: offscreen, width, height, naturalWidth, naturalHeight };
		}

		return { source: image, width, height, naturalWidth, naturalHeight };
	})();

	imageSourceCache.set(cacheKey, promise);
	void promise.catch(() => imageSourceCache.delete(cacheKey));
	return promise;
}

export class ImageNode extends VisualNode<
	ImageNodeParams,
	ResolvedVisualSourceNodeState & { source: CachedImageSource["source"] }
> {}
