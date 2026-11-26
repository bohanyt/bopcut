import { expect, test } from "bun:test";
import type { NormalizedCubicBezier, ScalarAnimationKey } from "@/animation/types";
import { fixture, getHost, rect, t } from "@/timeline/__tests__/compound-fixtures";
import { buildGraphEditorSegmentPatches, resolveGraphEditorSelectionState } from "./session";

test("a curve on a fill color scales each channel's handles by that channel's own span", () => {
	const scenes = fixture();
	const box = rect("box", 0, 5);
	const left = (value: number): ScalarAnimationKey => ({ id: "c0", time: t(0), value, segmentToNext: "linear", tangentMode: "auto" });
	const right = (value: number): ScalarAnimationKey => ({ id: "c1", time: t(1), value, segmentToNext: "linear", tangentMode: "auto" });
	box.animations = {
		"params.fill": {
			r: { keys: [left(0), right(1)] },
			g: { keys: [left(0), right(0.5)] },
			b: { keys: [left(0.8), right(0.2)] },
			a: { keys: [left(1), right(1)] },
		},
	} as never;
	getHost(scenes).tracks.overlay.find((track) => track.id === "t-gfx")!.elements = [box];
	const state = resolveGraphEditorSelectionState({
		tracks: scenes.find((scene) => scene.id === "main")!.tracks,
		selectedKeyframes: [{ trackId: "t-gfx", elementId: "box", propertyPath: "params.fill", keyframeId: "c0" }],
	});
	if (state.status !== "ready") throw new Error(`Graph editor not ready: ${state.status}`);
	const preset: NormalizedCubicBezier = [0.25, 0.1, 0.25, 1];
	const patches = buildGraphEditorSegmentPatches({ segment: state.segments[0], cubicBezier: preset });
	const outHandle = (channel: string) =>
		patches.find(({ context, keyframeId }) => context.componentKey === channel && keyframeId === "c0")?.patch.rightHandle;
	expect(outHandle("r")?.dv).toBeCloseTo(0.1, 6);
	expect(outHandle("g")?.dv).toBeCloseTo(0.05, 6);
	expect(outHandle("b")?.dv).toBeCloseTo(-0.06, 6);
	expect(outHandle("r")?.dt).toBe(outHandle("g")?.dt);
});
