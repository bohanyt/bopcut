import { expect, test } from "bun:test";
import { placeBuffer } from "./audio-manager";

const anchor = { timelineTime: 10, clockTime: 100 };
const base = { anchor, now: 100, clipStart: 12, clipDuration: 6, bufferLocalTime: 0, bufferSeconds: 1, rate: 1 };

test("at normal speed a buffer plays where its clip starts, at its own speed", () => {
	expect(placeBuffer({ ...base, speed: 1 })).toEqual({ startTimestamp: 102, startLocalTime: 0, offset: 0, duration: 1, playbackRate: 1 });
});

test("at 2× the timeline reaches the clip in half the time and the buffer plays twice as fast", () => {
	expect(placeBuffer({ ...base, speed: 2 })).toEqual({ startTimestamp: 101, startLocalTime: 0, offset: 0, duration: 1, playbackRate: 2 });
	// A retimed clip (1.5×) under a 4× shuttle: 6× on the audio clock.
	expect(placeBuffer({ ...base, speed: 4, rate: 1.5 })?.playbackRate).toBe(6);
});

test("joining a clip already under way at 2× starts in the buffer where the timeline is", () => {
	// 1 s of clock at 2× is 2 s of timeline: the playhead is at 12, the clip's start.
	expect(placeBuffer({ ...base, speed: 2, now: 101.25, bufferSeconds: 2 })).toEqual({
		startTimestamp: 101.25, startLocalTime: 0.5, offset: 0.5, duration: 1.5, playbackRate: 2,
	});
	// A buffer the playhead already passed plays nothing.
	expect(placeBuffer({ ...base, speed: 2, now: 102 })).toBeNull();
});
