import type { MediaAsset, MediaType } from "@/media/types";

export const SUPPORTS_AUDIO: readonly MediaType[] = ["audio", "video"];

export function mediaSupportsAudio({
	media,
}: {
	media: MediaAsset | null | undefined;
}): boolean {
	if (!media) return false;
	return SUPPORTS_AUDIO.includes(media.type);
}

export const isModelFile = (file: File): boolean => /\.(glb|gltf)$/i.test(file.name);

const MEDIA_EXTENSIONS: Record<MediaType, RegExp> = {
	video: /\.(mp4|m4v|mov|webm|mkv|ts|m2ts)$/i,
	audio: /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i,
	image: /\.(png|jpe?g|webp|avif|gif)$/i,
};

export function hasGenericMediaMimeType({ type }: File): boolean {
	return type === "" || type === "application/octet-stream";
}

export const getMediaTypeFromFile = ({
	file,
}: {
	file: File;
}): MediaType | null => {
	const { type } = file;

	if (isModelFile(file)) return "image";

	if (type.startsWith("image/")) {
		return "image";
	}
	if (type.startsWith("video/")) {
		return "video";
	}
	if (type.startsWith("audio/")) {
		return "audio";
	}

	if (hasGenericMediaMimeType(file)) {
		for (const kind of ["video", "audio", "image"] as const) {
			if (MEDIA_EXTENSIONS[kind].test(file.name)) return kind;
		}
	}

	return null;
};

export function extractMediaFilesFromClipboard({
	clipboardData,
}: {
	clipboardData: DataTransfer | null;
}): File[] {
	if (!clipboardData?.items) return [];

	const files: File[] = [];
	for (const item of clipboardData.items) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file && (getMediaTypeFromFile({ file }) || /^(image|video|audio)\//.test(item.type))) {
			files.push(file);
		}
	}
	return files;
}
