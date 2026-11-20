import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

/** A referenced or stored media file that could not be read. */
export type MediaLoadFailure = { id: string; name: string; error: string };

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	file: File;
	url?: string;
}
