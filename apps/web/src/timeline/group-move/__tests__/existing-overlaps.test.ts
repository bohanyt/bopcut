import { expect, test } from "bun:test";
import type { ElementRef, SceneTracks } from "@/timeline";
import { buildMoveGroup, resolveGroupMove } from "@/timeline/group-move";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const clip = (id: string, type: string, start: number, duration: number) =>
	({ id, type, name: id, mediaId: id, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(0), params: {} }) as never;

/**
 * A project written outside the editor: everything starts at 0.167 s, and two captions and two
 * sound effects already overlap a little.
 */
function project(): SceneTracks {
	return {
		overlay: [
			{ id: "captions", name: "Captions", type: "text", hidden: false, elements: [clip("c1", "text", 0.167, 1.2), clip("c2", "text", 1.3, 1)] },
		],
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [clip("m1", "video", 0.167, 3), clip("m2", "video", 3.167, 3)] },
		audio: [
			{ id: "vo", name: "VO", type: "audio", muted: false, elements: [clip("v1", "audio", 0.167, 2), clip("v2", "audio", 2.5, 2)] },
			{ id: "sfx", name: "SFX", type: "audio", muted: false, elements: [clip("s1", "audio", 0.2, 0.5), clip("s2", "audio", 0.6, 0.5)] },
		],
	} as never;
}
const everything = (tracks: SceneTracks): ElementRef[] =>
	[...tracks.overlay, tracks.main, ...tracks.audio].flatMap((track) => track.elements.map((element) => ({ trackId: track.id, elementId: element.id })));

function drag(tracks: SceneTracks, selected: ElementRef[], by: number) {
	const group = buildMoveGroup({ anchorRef: { trackId: "vo", elementId: "v1" }, selectedElements: selected, tracks })!;
	const result = resolveGroupMove({ group, tracks, anchorStartTime: T(0.167 + by), target: { kind: "existingTrack", anchorTargetTrackId: "vo" } });
	return result && Object.fromEntries(result.moves.map(({ elementId, newStartTime }) => [elementId, Math.round((newStartTime / TICKS_PER_SECOND) * 1000) / 1000]));
}

test("everything selected moves together although some clips already overlapped, and stops at 0", () => {
	const tracks = project();
	// The main track's first clip goes to 0 (it has no gap before it); the rest keep their spacing.
	expect(drag(tracks, everything(tracks), -0.09)).toEqual({ v1: 0, c1: 0, c2: 1.133, m1: 0, m2: 3, v2: 2.333, s1: 0.033, s2: 0.433 });
});

test("without the main track, the selection moves by the drag, and no clip goes before 0", () => {
	const tracks = project();
	const selected = everything(tracks).filter(({ trackId }) => trackId !== "main");
	expect(drag(tracks, selected, -0.09)).toMatchObject({ v1: 0.077, c1: 0.077, s1: 0.11, s2: 0.51 });
	expect(drag(tracks, selected, 0.3)).toMatchObject({ v1: 0.467, c2: 1.6, s2: 0.9 });
	expect(drag(tracks, selected, -5)).toMatchObject({ v1: 0, c1: 0, s1: 0.033 });
});

test("a moved clip still may not land on a clip that stays", () => {
	const tracks = project();
	// Only the second sound effect stays: the first, moved 0.3 s right, would cover it.
	const selected = [{ trackId: "vo", elementId: "v1" }, { trackId: "sfx", elementId: "s1" }];
	expect(drag(tracks, selected, 0.3)).toBeNull();
});
