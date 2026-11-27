import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import type { GrayFrame } from "./point-track";
import type { SourceRect } from "./split-layout";

/**
 * Small grey frames of a part of a video at the given source times (seconds), for tracking: only the
 * part is decoded into a canvas at most `width` pixels wide. A time with no picture gives a flat frame,
 * which the tracker treats as lost.
 */
export async function readGrayFrames({ file, crop, times, width = 240, signal, onProgress }: {
	file: Blob;
	crop: SourceRect;
	times: number[];
	width?: number;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}): Promise<GrayFrame[]> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("The clip has no picture to follow a face in");
		const displayWidth = track.displayWidth, displayHeight = track.displayHeight;
		const rect = {
			left: Math.round(crop.x * displayWidth),
			top: Math.round(crop.y * displayHeight),
			width: Math.max(2, Math.round(crop.width * displayWidth)),
			height: Math.max(2, Math.round(crop.height * displayHeight)),
		};
		const outWidth = Math.min(width, rect.width);
		const outHeight = Math.max(2, Math.round((outWidth * rect.height) / rect.width));
		const sink = new CanvasSink(track, { crop: rect, width: outWidth, height: outHeight, fit: "fill", poolSize: 2 });
		const frames: GrayFrame[] = [];
		let index = 0;
		for await (const wrapped of sink.canvasesAtTimestamps(times)) {
			signal?.throwIfAborted();
			const time = times[index++];
			const data = new Uint8Array(outWidth * outHeight);
			const context = wrapped?.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
			if (context) {
				const { data: rgba } = context.getImageData(0, 0, outWidth, outHeight);
				for (let pixel = 0; pixel < data.length; pixel++) {
					data[pixel] = (rgba[pixel * 4] * 299 + rgba[pixel * 4 + 1] * 587 + rgba[pixel * 4 + 2] * 114) / 1000;
				}
			}
			frames.push({ time, width: outWidth, height: outHeight, data });
			onProgress?.(index, times.length);
		}
		return frames;
	} finally {
		input.dispose();
	}
}
