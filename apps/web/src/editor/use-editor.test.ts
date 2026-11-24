import { expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { PlaybackManager } from "@/core/managers/playback-manager";
import { observePlaybackReads, PLAYBACK_STATE, PLAYBACK_TIME } from "@/core/playback-reads";
import { mediaTimeFromSeconds } from "@/wasm";
import { createEditorSubscription } from "./use-editor";

function createEditorSelector<T>(editor: EditorCore, read: () => T) {
	const subscription = createEditorSubscription(editor);
	let playbackReads = 0;
	subscription.commitReads(() => playbackReads);
	return {
		subscribe: subscription.subscribe,
		getSnapshot: () => {
			const { value, reads } = observePlaybackReads(read);
			playbackReads = reads;
			return value;
		},
	};
}

function setup() {
	const listeners = new Set<() => void>();
	const store = {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const editor = {
		timeline: { ...store, getTotalDuration: () => mediaTimeFromSeconds({ seconds: 30 }) },
		scenes: store,
		project: { ...store, getActiveOrNull: () => null, scheduleTimelineViewStatePlayhead: () => {} },
		media: store,
		renderer: store,
		selection: store,
		clipboard: store,
		diagnostics: store,
	} as unknown as EditorCore;
	const playback = new PlaybackManager(editor);
	Object.assign(editor, { playback });
	return { editor, playback, notify: () => listeners.forEach((listener) => listener()) };
}

test("public playback getters declare which changes can affect their value", () => {
	const { playback } = setup();
	const channels = {
		getIsPlaying: PLAYBACK_STATE,
		getCurrentTime: PLAYBACK_TIME,
		getPlaybackTime: PLAYBACK_STATE | PLAYBACK_TIME,
		getVolume: PLAYBACK_STATE,
		getOutputVolume: PLAYBACK_STATE,
		isMuted: PLAYBACK_STATE,
		getIsScrubbing: PLAYBACK_STATE,
	} as const;
	const getters = Object.getOwnPropertyNames(PlaybackManager.prototype)
		.filter((name) => /^(get|is)[A-Z]/.test(name));
	expect(getters.sort()).toEqual(Object.keys(channels).sort());
	for (const getter of Object.keys(channels) as Array<keyof typeof channels>) {
		const { reads } = observePlaybackReads(() => playback[getter]());
		expect(reads).toBe(channels[getter]);
	}
});

test("only selectors that read playback time are checked on seek", () => {
	const { editor, playback } = setup();
	const readTime = () => playback.getCurrentTime();
	const unrelated = createEditorSelector(editor, () => 42);
	const state = createEditorSelector(editor, () => playback.getIsScrubbing());
	const time = createEditorSelector(editor, readTime);
	const calls: string[] = [];
	const subscriptions = [
		["unrelated", unrelated],
		["state", state],
		["time", time],
	] as const;
	const stop = subscriptions.map(([label, selector]) => {
		selector.getSnapshot();
		return selector.subscribe(() => {
			calls.push(label);
			selector.getSnapshot();
		});
	});

	playback.seek({ time: mediaTimeFromSeconds({ seconds: 1 }) });
	expect(calls).toEqual(["time"]);
	playback.setScrubbing({ isScrubbing: true });
	expect(calls).toEqual(["time", "state"]);
	stop.forEach((unsubscribe) => unsubscribe());
	playback.seek({ time: mediaTimeFromSeconds({ seconds: 2 }) });
	expect(calls).toEqual(["time", "state"]);
});

test("a conditional selector follows newly observed time without a value change", () => {
	const { editor, playback, notify } = setup();
	let followsTime = false;
	const selector = createEditorSelector(editor, () =>
		followsTime ? playback.getCurrentTime() : 0,
	);
	const values: number[] = [selector.getSnapshot()];
	const stop = selector.subscribe(() => values.push(selector.getSnapshot()));

	followsTime = true;
	notify();
	const second = mediaTimeFromSeconds({ seconds: 1 });
	playback.seek({ time: second });
	expect(values).toEqual([0, 0, second]);

	followsTime = false;
	notify();
	playback.seek({ time: mediaTimeFromSeconds({ seconds: 2 }) });
	expect(values).toEqual([0, 0, second, 0]);
	stop();
});

test("playback ticks check time selectors and play and pause check state selectors", () => {
	const { editor, playback } = setup();
	const raf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
	const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
	let frame: FrameRequestCallback | undefined;
	let clock = 0;
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: (callback: FrameRequestCallback) => { frame = callback; return 1; },
	});
	Object.defineProperty(globalThis, "cancelAnimationFrame", {
		configurable: true,
		value: () => { frame = undefined; },
	});
	const state = createEditorSelector(editor, () => playback.getIsPlaying());
	const time = createEditorSelector(editor, () => playback.getCurrentTime());
	const playing: boolean[] = [state.getSnapshot()];
	const times: number[] = [time.getSnapshot()];
	const stopState = state.subscribe(() => playing.push(state.getSnapshot()));
	const stopTime = time.subscribe(() => times.push(time.getSnapshot()));
	try {
		playback.setPlaybackClock(() => clock);
		playback.play();
		clock = 1;
		frame?.(1000);
		playback.pause();
		expect(playing).toEqual([false, true, false]);
		expect(times).toEqual([0, 0, mediaTimeFromSeconds({ seconds: 1 })]);
	} finally {
		stopState();
		stopTime();
		if (raf) Object.defineProperty(globalThis, "requestAnimationFrame", raf);
		else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
		if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
		else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
	}
});
