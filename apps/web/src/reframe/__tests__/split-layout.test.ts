import { expect, test } from "bun:test";
import { buildSplitLayout, framePart, type SourceRect } from "../split-layout";
import { fixture, getHost, text, video } from "@/timeline/__tests__/compound-fixtures";
import type { RectangleMaskParams } from "@/masks/types";
import type { VideoElement } from "@/timeline";

const canvas = { width: 1080, height: 1920 };
const media = { width: 1920, height: 1080 };
const names = { facecamTrack: "Facecam", facecamClip: (name: string) => `${name} (facecam)` };

/** Where a part of the source lands on the canvas for a clip with this scale and position. */
function shownPart(part: SourceRect, frame: { scale: number; positionX: number; positionY: number }) {
	const fit = Math.min(canvas.width / media.width, canvas.height / media.height);
	const width = media.width * fit * frame.scale, height = media.height * fit * frame.scale;
	const left = canvas.width / 2 + frame.positionX - width / 2, top = canvas.height / 2 + frame.positionY - height / 2;
	return { left: left + part.x * width, top: top + part.y * height, right: left + (part.x + part.width) * width, bottom: top + (part.y + part.height) * height };
}

test.each([
	{ part: { x: 0, y: 0, width: 1, height: 1 }, window: { top: 0, height: 1152 } },
	{ part: { x: 0.02, y: 0.62, width: 0.22, height: 0.34 }, window: { top: 1152, height: 768 } },
	{ part: { x: 0.7, y: 0.05, width: 0.28, height: 0.3 }, window: { top: 960, height: 960 } },
])("a part of the source covers its window, centred on it (%#)", ({ part, window }) => {
	const shown = shownPart(part, framePart({ part, window, media, canvas }));
	expect(shown.left).toBeLessThanOrEqual(0.001);
	expect(shown.right).toBeGreaterThanOrEqual(canvas.width - 0.001);
	expect(shown.top).toBeLessThanOrEqual(window.top + 0.001);
	expect(shown.bottom).toBeGreaterThanOrEqual(window.top + window.height - 0.001);
	expect((shown.left + shown.right) / 2).toBeCloseTo(canvas.width / 2, 6);
	expect((shown.top + shown.bottom) / 2).toBeCloseTo(window.top + window.height / 2, 6);
	// It fills one side exactly: no more zoom than the window needs.
	expect(Math.min(shown.right - shown.left - canvas.width, shown.bottom - shown.top - window.height)).toBeCloseTo(0, 6);
});

test("the clip becomes the game on top and a silent copy on a new top track shows the facecam", () => {
	const scenes = fixture();
	const tracks = getHost(scenes).tracks;
	const clip: VideoElement = {
		...video("stream", 0, 30), agentId: "stream",
		animations: { "transform.positionX": { keys: [] }, opacity: { keys: [] } } as never,
	};
	tracks.main.elements = [clip];
	tracks.overlay = [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [text("title", 0, 2)] }];
	const facecam = { x: 0.02, y: 0.62, width: 0.22, height: 0.34 };
	const result = buildSplitLayout({ tracks, clip: { trackId: tracks.main.id, elementId: "stream" }, facecam, split: 0.6, media, canvas, names })!;
	const game = result.tracks.main.elements[0] as VideoElement;
	const [facecamTrack, titles] = result.tracks.overlay;
	const cam = facecamTrack.elements[0] as VideoElement;

	expect(result.game).toEqual({ trackId: tracks.main.id, elementId: "stream" });
	expect(result.facecam).toEqual({ trackId: facecamTrack.id, elementId: cam.id });
	expect(titles.id).toBe("titles");
	expect(facecamTrack).toMatchObject({ name: "Facecam", type: "video" });
	expect(cam).toMatchObject({ name: "stream (facecam)", mediaId: clip.mediaId, startTime: clip.startTime, duration: clip.duration });
	expect(cam.id).not.toBe("stream");
	expect(cam.agentId).toBeUndefined();
	expect(cam.params.muted).toBe(true);
	expect(game.params.muted).toBeUndefined();

	const window = (element: VideoElement) => element.masks?.[0].params as RectangleMaskParams;
	expect(window(game)).toMatchObject({ canvasLocked: true, centerX: 0, width: 1 });
	expect(window(game).centerY).toBeCloseTo(-0.2, 6);
	expect(window(game).height).toBeCloseTo(0.6, 6);
	expect(window(cam).centerY).toBeCloseTo(0.3, 6);
	expect(window(cam).height).toBeCloseTo(0.4, 6);
	// The layout's frames replace transform keys; other keys stay.
	expect(Object.keys(game.animations ?? {})).toEqual(["opacity"]);
	expect(game.params["transform.scaleX"]).toBe(game.params["transform.scaleY"]);
});

test("a share outside the limits is clamped, and a clip that is not a video is left alone", () => {
	const scenes = fixture();
	const tracks = getHost(scenes).tracks;
	tracks.main.elements = [video("stream", 0, 10)];
	tracks.overlay = [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [text("title", 0, 2)] }];
	const wide = buildSplitLayout({ tracks, clip: { trackId: tracks.main.id, elementId: "stream" }, facecam: { x: 0, y: 0, width: 0.3, height: 0.3 }, split: 0.95, media, canvas, names })!;
	expect(((wide.tracks.main.elements[0] as VideoElement).masks?.[0].params as RectangleMaskParams).height).toBeCloseTo(0.8, 6);
	expect(buildSplitLayout({ tracks, clip: { trackId: "titles", elementId: "title" }, facecam: { x: 0, y: 0, width: 0.3, height: 0.3 }, media, canvas, names })).toBeNull();
});
