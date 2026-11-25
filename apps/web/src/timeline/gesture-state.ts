/**
 * Edits that commit only on release, such as moving clips or dragging a keyframe, a handle or a color:
 * their state lives in the component that runs them, not in the timeline. While one runs, agent drafts
 * wait, so a draft never changes the timeline under the user's hand.
 */
let active = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/** Marks a gesture as running; call the returned function once it ends (calling it again does nothing). */
export function beginTimelineGesture(): () => void {
	active++;
	notify();
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		active--;
		notify();
	};
}

export function isTimelineGestureActive(): boolean {
	return active > 0;
}

/** Notified when a gesture starts or ends. */
export function subscribeTimelineGestures(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
