// Sound effect library types shared by the server, the agent bridge and the UI.

/** `library`: the user's own sound folders. `myinstants`: myinstants.com (no account or key needed). */
export type SfxSource = "library" | "myinstants";
export const SFX_SOURCES: readonly SfxSource[] = ["library", "myinstants"];

export type SfxResult = {
	source: SfxSource;
	/** Opaque reference for `get`. */
	ref: string;
	name: string;
	/** Folder names (library) used as tags. */
	tags: string[];
	/** Playable URL for a quick listen. */
	previewUrl: string;
	pageUrl?: string;
};

/** A sound saved under AGENT_FILES_ROOT, ready to use as an asset `path`. */
export type SfxFile = {
	path: string;
	name: string;
	source: SfxSource;
	pageUrl?: string;
	cached: boolean;
};
