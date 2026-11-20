// Media object URLs are revoked only when no export is running: an export reads images by their URL
// and must not lose one halfway (for example when the user removes the image meanwhile).

let holds = 0;
const pending = new Set<string>();

/** Keeps every media URL usable until the returned release is called (once per export). */
export function holdMediaUrls(): () => void {
	holds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds--;
		if (holds > 0) return;
		for (const url of pending) URL.revokeObjectURL(url);
		pending.clear();
	};
}

/** Revokes a media URL now, or when the running export ends. */
export function revokeMediaUrl(url: string): void {
	if (holds > 0) pending.add(url);
	else URL.revokeObjectURL(url);
}
