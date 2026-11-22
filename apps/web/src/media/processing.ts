import { toast } from "sonner";
import { GIF_SOURCE_FPS_HEADER, GIF_VARIABLE_DELAY_HEADER, getMediaTypeFromFile, hasGenericMediaMimeType, isModelFile } from "@/media/media-utils";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import type { MediaAsset } from "@/media/types";
import { readVideoFile } from "./mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";
import { releaseMediaAssetUrls } from "./url-release";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const getStorageLimitDescription = ({
	fileSize,
	availableBytes,
}: {
	fileSize: number;
	availableBytes: number | null;
}): string => {
	const fileSizeLabel = formatStorageBytes({ bytes: fileSize });

	if (availableBytes === null) {
		return `File size is ${fileSizeLabel}.`;
	}

	return `File size is ${fileSizeLabel}, but only ${formatStorageBytes({
		bytes: availableBytes,
	})} is safely available in browser storage.`;
};

async function generateImageThumbnail({
	url,
	signal,
}: {
	url: string;
	signal: AbortSignal;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			image.onload = null;
			image.onerror = null;
			image.removeAttribute("src");
		};
		const abort = () => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		image.onload = () => {
			try {
				const thumbnailUrl = renderThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve({
					thumbnailUrl,
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				cleanup();
			}
		};

		image.onerror = () => {
			cleanup();
			reject(new Error("Could not load image"));
		};

		image.src = url;
	});
}

export async function processMediaFile({
	file: original,
	signal,
}: {
	file: File;
	signal: AbortSignal;
}): Promise<ProcessedMediaAsset | null> {
	if (signal.aborted) return null;
	// Convert GIF to video on the local server to preserve animation and transparency.
	let file = original;
	let gifSourceFps: number | undefined;
	let hasVariableGifDelay = false;
	if (original.type === "image/gif" || (hasGenericMediaMimeType(original) && /\.gif$/i.test(original.name))) {
		try {
			const res = await fetch("/api/agent/gif", { method: "POST", body: original, signal });
			if (!res.ok) throw new Error(await res.text());
			const converted = await res.blob();
			const type = converted.type;
			if (type !== "video/mp4" && type !== "video/webm") throw new Error("Unexpected GIF conversion format");
			const extension = type === "video/webm" ? "webm" : "mp4";
			file = new File([converted], original.name.replace(/\.gif$/i, "") + "." + extension, { type });
			// Some FFmpeg versions duplicate frames to represent GIF holds. Keep the source cadence.
			const sourceFps = Number(res.headers.get(GIF_SOURCE_FPS_HEADER));
			if (Number.isFinite(sourceFps) && sourceFps > 0) gifSourceFps = sourceFps;
			hasVariableGifDelay = res.headers.get(GIF_VARIABLE_DELAY_HEADER) === "1";
		} catch (error) {
			if (signal.aborted) return null;
			toast.error(`GIF ${original.name} could not be converted to video; using a still image`);
		}
	}
	const fileType = getMediaTypeFromFile({ file });
	const inferredType = hasGenericMediaMimeType(original);

	if (!fileType) {
		toast.error(`Unsupported file type: ${file.name}`);
		return null;
	}

	const storageCheck = await storageService.canStoreFile({
		size: file.size,
	});
	if (signal.aborted) return null;

	if (!storageCheck.canStore) {
		toast.error(`Not enough browser storage for ${file.name}`, {
			description: getStorageLimitDescription({
				fileSize: file.size,
				availableBytes: storageCheck.availableBytes,
			}),
		});
		return null;
	}

	let thumbnailUrl: string | undefined;
	let url: string | undefined;
	let duration: number | undefined;
	let width: number | undefined;
	let height: number | undefined;
	let fps: number | undefined;
	let hasAudio: boolean | undefined;

	try {
		if (isModelFile(file)) {
			width = 512;
			height = 512;
			thumbnailUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#30343b"/><path d="M64 22 100 42v42L64 106 28 84V42Z M28 42l36 21 36-21M64 63v43" fill="none" stroke="#b7c5d5" stroke-width="4"/></svg>')}`;
		} else if (fileType === "image") {
			url = URL.createObjectURL(file);
			const result = await generateImageThumbnail({ url, signal });
			thumbnailUrl = result.thumbnailUrl;
			width = result.width;
			height = result.height;
		} else if (fileType === "video") {
			try {
				const videoData = await readVideoFile({ file, signal });
				if (signal.aborted) return null;
				duration = videoData.duration;
				width = videoData.width;
				height = videoData.height;
				const sourceFps = gifSourceFps ?? videoData.fps;
				fps = Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : undefined;
				hasAudio = videoData.hasAudio;
				thumbnailUrl = videoData.thumbnailUrl ?? undefined;

				if (videoData.audioUnavailable) {
					toast.warning(`Audio unavailable in ${file.name}`, {
						description: "The video can be used without its soundtrack. Convert the audio to AAC if you need it.",
					});
				}
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Could not process video";

				if (!signal.aborted) toast.error(`Couldn't process ${file.name}`, { description: message });
				return null;
			}
		} else if (fileType === "audio") {
			url = URL.createObjectURL(file);
			duration = await getAudioDuration({ url, signal });
			if (inferredType && (!Number.isFinite(duration) || duration <= 0)) {
				throw new Error("The file does not have a finite audio duration");
			}
		}

		if (signal.aborted) {
			releaseMediaAssetUrls({ url, thumbnailUrl });
			return null;
		}
		url ??= URL.createObjectURL(file);
		return {
			name: file.name, type: fileType, file, url, thumbnailUrl, duration, width, height, fps, hasAudio,
			...(hasVariableGifDelay && { hasVariableGifDelay }),
		};
	} catch (error) {
		releaseMediaAssetUrls({ url, thumbnailUrl });
		if (!signal.aborted) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
		}
		return null;
	}
}

const getAudioDuration = ({ url, signal }: { url: string; signal: AbortSignal }): Promise<number> => {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const element = document.createElement("audio");
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			element.onloadedmetadata = null;
			element.onerror = null;
			element.removeAttribute("src");
			element.load();
		};
		const abort = () => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		element.onloadedmetadata = () => {
			resolve(element.duration);
			cleanup();
		};

		element.onerror = () => {
			reject(new Error("Could not load media"));
			cleanup();
		};

		element.src = url;
		element.load();
	});
};
