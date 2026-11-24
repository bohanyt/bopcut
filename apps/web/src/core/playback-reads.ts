export const PLAYBACK_STATE = 1;
export const PLAYBACK_TIME = 2;

let reads: number | null = null;

/** Records synchronous playback reads, including reads through another manager. */
export function observePlaybackReads<T>(read: () => T) {
	const previous = reads;
	reads = 0;
	try {
		const value = read();
		return { value, reads };
	} finally {
		reads = previous;
	}
}

export function recordPlaybackRead(channel: number): void {
	if (reads !== null) reads |= channel;
}
