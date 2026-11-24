import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";
import {
	observePlaybackReads,
	PLAYBACK_STATE,
	PLAYBACK_TIME,
} from "@/core/playback-reads";

const SNAPSHOT_UNSET = Symbol("snapshotUnset");

function isShallowEqual({
	a,
	b,
}: {
	a: unknown;
	b: unknown;
}): boolean {
	if (Object.is(a, b)) return true;
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	if (a.length !== b.length) return false;
	return a.every((item, i) => Object.is(item, b[i]));
}

const subscribeNone = () => () => {};
const noPlaybackReads = () => 0;

export function useEditor(): EditorCore;
export function useEditor<T>(selector: (editor: EditorCore) => T): T;
export function useEditor<T>(
	selector?: (editor: EditorCore) => T,
): EditorCore | T {
	const editor = useMemo(() => EditorCore.getInstance(), []);
	const snapshotCacheRef = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);
	const subscription = useMemo(() => createEditorSubscription(editor), [editor]);

	const snapshot = useMemo(() => {
		if (!selector) return { read: () => editor, playbackReads: noPlaybackReads };
		let playbackReads = 0;
		const read = () => {
			const { value: next, reads } = observePlaybackReads(() => selector(editor));
			playbackReads = reads;
			const previous = snapshotCacheRef.current;
			if (
				previous !== SNAPSHOT_UNSET &&
				isShallowEqual({ a: previous, b: next })
			) {
				return previous;
			}
			snapshotCacheRef.current = next;
			return next;
		};
		return { read, playbackReads: () => playbackReads };
	}, [editor, selector]);

	const value = useSyncExternalStore<EditorCore | T>(
		selector ? subscription.subscribe : subscribeNone,
		snapshot.read,
		snapshot.read,
	);
	useEffect(() => {
		// Publish dependencies after React commits the corresponding snapshot reader.
		subscription.commitReads(snapshot.playbackReads);
	}, [snapshot, subscription]);
	return value;
}

export function createEditorSubscription(editor: EditorCore) {
	let getPlaybackReads = noPlaybackReads;
	let refresh: (() => void) | undefined;
	const subscribe = (onChange: () => void) => {
		let stopState: (() => void) | undefined;
		let stopTime: (() => void) | undefined;
		const refreshPlaybackSubscriptions = () => {
			const playbackReads = getPlaybackReads();
			if (playbackReads & PLAYBACK_STATE) {
				stopState ??= editor.playback.subscribeState(check);
			} else {
				stopState?.();
				stopState = undefined;
			}
			if (playbackReads & PLAYBACK_TIME) {
				stopTime ??= editor.playback.subscribeTime(check);
			} else {
				stopTime?.();
				stopTime = undefined;
			}
		};
		const check = () => {
			// React reads the snapshot synchronously here, even when its value
			// stays equal. A conditional selector may have read new dependencies.
			onChange();
			refresh?.();
		};
		const unsubscribers = [
			editor.timeline.subscribe(check),
			editor.scenes.subscribe(check),
			editor.project.subscribe(check),
			editor.media.subscribe(check),
			editor.renderer.subscribe(check),
			editor.selection.subscribe(check),
			editor.clipboard.subscribe(check),
			editor.diagnostics.subscribe(check),
		];
		refresh = refreshPlaybackSubscriptions;
		refresh();
		return () => {
			refresh = undefined;
			for (const unsubscribe of unsubscribers) unsubscribe();
			stopState?.();
			stopTime?.();
		};
	};

	return {
		subscribe,
		commitReads: (read: () => number) => {
			getPlaybackReads = read;
			refresh?.();
		},
	};
}
