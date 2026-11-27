import { expect, test } from "bun:test";
import type { SceneTracks, TimelineElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";
import { audio, t, text, video } from "@/timeline/__tests__/compound-fixtures";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import { referenceApplyRippleAdjustments, referenceComputeRippleAdjustments } from "./reference-ripple";

/** A small deterministic generator, so a failure repeats. */
function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

type Make = (id: string, start: number, duration: number) => TimelineElement;

function lane(next: () => number, prefix: string, make: Make): TimelineElement[] {
	const elements: TimelineElement[] = [];
	let at = Math.floor(next() * 3);
	for (let index = 0; index < 2 + Math.floor(next() * 10); index++) {
		const duration = 1 + Math.floor(next() * 4);
		elements.push(make(`${prefix}${index}`, at, duration));
		at += duration + Math.floor(next() * 3);
	}
	return elements;
}

/** Deletes, shortens and moves some clips of some tracks; the others keep their element arrays. */
function edit(next: () => number, before: SceneTracks): SceneTracks {
	const moved: TimelineElement[] = [];
	const change = (elements: TimelineElement[]): TimelineElement[] => {
		if (next() < 0.4) return elements;
		const shift = next() < 0.5 ? t(-1) : t(2);
		return elements.flatMap((element): TimelineElement[] => {
			const roll = next();
			if (roll < 0.2) return [];
			if (roll < 0.3) {
				moved.push(element);
				return [];
			}
			if (roll < 0.45) return [{ ...element, duration: t(0.5) }];
			if (roll < 0.55) return [{ ...element, startTime: (element.startTime + shift) as MediaTime }];
			if (roll < 0.6) return [{ ...element, startTime: (element.startTime - t(0.5)) as MediaTime, duration: (element.duration - t(0.5)) as MediaTime }];
			return [element];
		});
	};
	const after: SceneTracks = {
		overlay: before.overlay.map((track) => ({ ...track, elements: change(track.elements) })) as SceneTracks["overlay"],
		main: { ...before.main, elements: change(before.main.elements) as SceneTracks["main"]["elements"] },
		audio: before.audio.map((track) => ({ ...track, elements: change(track.elements) })) as SceneTracks["audio"],
	};
	// Clips moved to another track: the last overlay track takes them at their place.
	const target = after.overlay.at(-1);
	if (target && moved.length) target.elements = [...target.elements, ...moved.map((element) => ({ ...element, startTime: (element.startTime + t(40)) as MediaTime }))] as typeof target.elements;
	return after;
}

test("ripple gives the same adjustments and tracks as before it skipped untouched tracks and sorted once", () => {
	const next = random(11);
	let rippled = 0;
	for (let round = 0; round < 400; round++) {
		const before: SceneTracks = {
			overlay: [
				{ id: "o1", name: "Text", type: "text", hidden: false, elements: lane(next, "o1-", text) },
				{ id: "o2", name: "Video", type: "video", muted: false, hidden: false, elements: lane(next, "o2-", video) },
			] as SceneTracks["overlay"],
			main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: lane(next, "m-", video) } as SceneTracks["main"],
			audio: [{ id: "a1", name: "Audio", type: "audio", muted: false, elements: lane(next, "a1-", audio) }] as SceneTracks["audio"],
		};
		const after = edit(next, before);
		const adjustments = computeRippleAdjustments({ beforeTracks: before, afterTracks: after });
		const expected = referenceComputeRippleAdjustments({ beforeTracks: before, afterTracks: after });
		expect(adjustments).toEqual(expected);
		if (expected.length > 1) rippled++;
		expect(applyRippleAdjustments({ tracks: after, adjustments })).toEqual(referenceApplyRippleAdjustments({ tracks: after, adjustments: expected }));
	}
	// Most rounds free several gaps, so the comparison covers more than empty diffs.
	expect(rippled).toBeGreaterThan(200);
});

test("an untouched track keeps its element array", () => {
	const main = { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [video("a", 0, 2), video("b", 3, 2)] } as SceneTracks["main"];
	const caption = { id: "c", name: "Text", type: "text", hidden: false, elements: [text("c", 0, 5)] } as SceneTracks["overlay"][number];
	const before: SceneTracks = { overlay: [caption], main, audio: [] };
	const after: SceneTracks = { overlay: [caption], main: { ...main, elements: [main.elements[1]] }, audio: [] };
	const adjustments = computeRippleAdjustments({ beforeTracks: before, afterTracks: after });
	expect(adjustments).toEqual([{ trackId: "main", afterTime: t(2), shiftAmount: t(2) }]);
	const rippled = applyRippleAdjustments({ tracks: after, adjustments });
	expect(rippled.overlay[0]).toBe(caption);
	expect(rippled.main.elements.map(({ id, startTime }) => [id, startTime])).toEqual([["b", t(1)]]);
});
