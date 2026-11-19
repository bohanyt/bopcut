// Music library types shared by the server, the agent bridge and the UI.

/** `library`: the user's own music folders. `online`: a song found or linked online, fetched with yt-dlp. */
export type MusicSource = "library" | "online";
export const MUSIC_SOURCES: readonly MusicSource[] = ["library", "online"];

export type MusicResult = {
	source: MusicSource;
	/** Opaque reference for `get` (a library reference, or the song's page link). */
	ref: string;
	name: string;
	tags: string[];
	/** Seconds, when known. */
	duration?: number;
	/** Playable URL for library songs; online songs are previewed on their page. */
	previewUrl?: string;
	pageUrl?: string;
};

/** A song saved under AGENT_FILES_ROOT, ready to use as an asset `path`. */
export type MusicFile = {
	path: string;
	name: string;
	source: MusicSource;
	pageUrl?: string;
	uploader?: string;
	cached: boolean;
};
