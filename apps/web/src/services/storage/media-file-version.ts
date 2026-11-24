// Keep the disk revision with the File instance without changing the imported file's metadata.
const versions = new WeakMap<File, string>();

export function recordMediaFileVersion(file: File, version: string | null): void {
	if (version) versions.set(file, version);
}

export function mediaFileVersion(file: File): string | undefined {
	return versions.get(file);
}
