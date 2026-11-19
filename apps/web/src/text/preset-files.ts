// Server side: where a text preset is saved in the workspace `presets/` folder.
import { createHash } from "node:crypto";

/**
 * The file for a new preset: a readable stem plus a digest of the exact name. "Readable" and "readable"
 * differ in the digest, so they never share a file on case-insensitive file systems.
 */
export function presetFileName(name: string): string {
	const stem =
		name
			.normalize("NFKC")
			.replace(/[^\p{L}\p{N}_-]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "preset";
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
	return `${stem}-${digest}.json`;
}
