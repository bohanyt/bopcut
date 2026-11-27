import { expect, mock, test } from "bun:test";
import type { TScene, VideoElement } from "@/timeline";
import { fixture, getHost, video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("@/agent/draft");

function scenes(): TScene[] {
	const list = fixture();
	const host = getHost(list);
	host.tracks.main.elements = [{ ...video("stream", 0, 30), agentId: "stream" }];
	host.tracks.overlay = [];
	return list;
}
const run = (ops: unknown[], { canvas = { width: 1080, height: 1920 }, known = true } = {}) => computeAgentDraft({
	scenes: scenes(), rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas,
	fps: { numerator: 30, denominator: 1 }, ripple: false,
	sizeOf: (mediaId) => (known && mediaId === "media-stream" ? { width: 1920, height: 1080 } : undefined),
});
const facecam = { x: 0.02, y: 0.62, width: 0.22, height: 0.34 };

test("an agent splits a clip into the game and a facecam copy it can address", () => {
	const out = run([{ op: "split-layout", match: { agentId: "stream" }, facecam, split: 0.6 }]);
	expect(out.results[0]).toMatchObject({ ok: true, facecam: { agentId: "stream~facecam" } });
	const tracks = getHost(out.scenes).tracks;
	const cam = tracks.overlay[0].elements[0] as VideoElement;
	expect(cam).toMatchObject({ agentId: "stream~facecam", name: "stream (facecam)" });
	expect(cam.params.muted).toBe(true);
	expect(cam.masks?.[0].params).toMatchObject({ canvasLocked: true });
	expect((tracks.main.elements[0] as VideoElement).masks?.[0].params).toMatchObject({ canvasLocked: true });
});

test.each([
	[{ canvas: { width: 1920, height: 1080 } }, { facecam }, "needs a vertical canvas"],
	[{ known: false }, { facecam }, "picture size is not known"],
	[{}, { facecam: { x: 0.9, y: 0, width: 0.3, height: 0.3 } }, "inside it"],
	[{}, { facecam: { x: 0, y: 0, width: 0.01, height: 0.3 } }, "inside it"],
	[{}, { facecam, split: 0.95 }, "share of the height"],
	[{}, { facecam, gameX: 1.2 }, "left edge of the game's crop"],
] as const)("a bad request says why and changes nothing (%#)", (options, op, message) => {
	const out = run([{ op: "split-layout", match: { agentId: "stream" }, ...op }], options);
	expect(out.results[0].ok).toBe(false);
	expect(out.results[0].error).toContain(message);
	expect(getHost(out.scenes).tracks.overlay).toEqual([]);
});
