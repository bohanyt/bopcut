import { toast } from "sonner";
import { getMediaTypeFromFile, hasGenericMediaMimeType, isModelFile } from "@/media/media-utils";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import type { MediaAsset } from "@/media/types";
import { readVideoFile } from "./mediabunny";
import type { VideoFileData } from "./mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";
import { releaseMediaAssetUrls } from "./url-release";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const getUnsupportedVideoDescription = ({
	codec,
}: {
	codec: VideoFileData["codec"];
}): string => {
	const codecLabel = codec ? codec.toUpperCase() : "this video codec";

	return codec === "hevc"
		? `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 or try importing it in Safari.`
		: `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
};

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
	// Convert GIF to MP4 on the local server to preserve animation.
	let file = original;
	if (original.type === "image/gif" || (hasGenericMediaMimeType(original) && /\.gif$/i.test(original.name))) {
		try {
			const res = await fetch("/api/agent/gif", { method: "POST", body: original, signal });
			if (!res.ok) throw new Error(await res.text());
			file = new File([await res.blob()], original.name.replace(/\.gif$/i, "") + ".mp4", { type: "video/mp4" });
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
				duration = videoData.duration;
				width = videoData.width;
				height = videoData.height;
				fps = Number.isFinite(videoData.fps) && videoData.fps > 0 ? videoData.fps : undefined;
				hasAudio = videoData.hasAudio;
				thumbnailUrl = videoData.thumbnailUrl ?? undefined;

				if (!videoData.canDecode) {
					const description = getUnsupportedVideoDescription({ codec: videoData.codec });
					if (inferredType) throw new Error(description);
					toast.error(`Can't preview ${file.name}`, {
						description,
					});
				}
				if (inferredType && (!Number.isFinite(duration) || duration <= 0)) {
					throw new Error("The file does not contain playable video");
				}
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Could not process video";

				if (!signal.aborted) toast.error(`Couldn't process ${file.name}`, { description: message });
				if (inferredType) {
					releaseMediaAssetUrls({ thumbnailUrl });
					return null;
				}
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
		return { name: file.name, type: fileType, file, url, thumbnailUrl, duration, width, height, fps, hasAudio };
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
