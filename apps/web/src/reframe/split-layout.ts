import type { RectangleMask } from "@/masks/types";
import type { ElementRef, SceneTracks, TimelineTrack, VideoElement, VideoTrack } from "@/timeline/types";
import { generateUUID } from "@/utils/id";

/** A part of the source picture, in fractions of its width and height from its top left. */
export interface SourceRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Shares of the canvas height the game may take: the rest is the facecam. */
export const SPLIT_LIMITS = { min: 0.3, max: 0.8, default: 0.6 } as const;

const TRANSFORM_KEYS = ["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY", "transform.rotate"];

function windowMask({ top, height, canvasHeight }: { top: number; height: number; canvasHeight: number }): RectangleMask {
	// Locked to the canvas, so the picture can move and zoom behind a still window.
	return {
		id: generateUUID(),
		type: "rectangle",
		params: {
			centerX: 0, centerY: (top + height / 2) / canvasHeight - 0.5, width: 1, height: height / canvasHeight,
			rotation: 0, scale: 1, feather: 0, inverted: false, strokeColor: "#ffffff", strokeWidth: 0, strokeAlign: "inside",
			canvasLocked: true,
		},
	};
}

/**
 * The scale and position that fill a window of the canvas with a part of the source: the part covers
 * the window (the rest of it is cut by the window's mask) and its centre sits at the window's centre.
 */
export function framePart({ part, window, media, canvas }: {
	part: SourceRect;
	window: { top: number; height: number };
	media: { width: number; height: number };
	canvas: { width: number; height: number };
}) {
	// The editor first fits the source inside the canvas, then applies the scale.
	const fit = Math.min(canvas.width / media.width, canvas.height / media.height);
	const shownWidth = media.width * fit, shownHeight = media.height * fit;
	const scale = Math.max(canvas.width / (part.width * shownWidth), window.height / (part.height * shownHeight));
	const partX = (part.x + part.width / 2 - 0.5) * shownWidth * scale;
	const partY = (part.y + part.height / 2 - 0.5) * shownHeight * scale;
	return {
		scale,
		positionX: -partX,
		positionY: window.top + window.height / 2 - canvas.height / 2 - partY,
	};
}

function withoutTransformKeys(element: VideoElement): VideoElement["animations"] {
	if (!element.animations) return element.animations;
	const kept = Object.fromEntries(Object.entries(element.animations).filter(([path]) => !TRANSFORM_KEYS.includes(path)));
	return Object.keys(kept).length ? (kept as VideoElement["animations"]) : undefined;
}

function placed(element: VideoElement, frame: ReturnType<typeof framePart>, mask: RectangleMask): VideoElement {
	return {
		...element,
		params: {
			...element.params,
			"transform.positionX": frame.positionX,
			"transform.positionY": frame.positionY,
			"transform.scaleX": frame.scale,
			"transform.scaleY": frame.scale,
			"transform.rotate": 0,
		},
		// The layout's frames replace any transform keys; other keys (opacity, effects) stay.
		animations: withoutTransformKeys(element),
		masks: [mask],
	};
}

/**
 * Splits a 16:9 clip into the vertical layout of stream clips: the game on top and the facecam below,
 * both from the same clip. The clip itself becomes the game (with its sound); a silent copy on a new
 * track above shows the facecam. Returns the new tracks and the two clips, or null when the clip is
 * not a video on these tracks.
 */
export function buildSplitLayout({ tracks, clip, facecam, split = SPLIT_LIMITS.default, game = { x: 0, y: 0, width: 1, height: 1 }, media, canvas, names, facecamAgentId }: {
	tracks: SceneTracks;
	clip: ElementRef;
	/** The facecam's part of the source. */
	facecam: SourceRect;
	/** The game's share of the canvas height. */
	split?: number;
	/** The game's part of the source (all of it by default). */
	game?: SourceRect;
	media: { width: number; height: number };
	canvas: { width: number; height: number };
	names: { facecamTrack: string; facecamClip: (name: string) => string };
	/** The facecam copy's agent ID, when an agent made the layout. */
	facecamAgentId?: string;
}): { tracks: SceneTracks; game: ElementRef; facecam: ElementRef } | null {
	const all: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
	const track = all.find(({ id }) => id === clip.trackId);
	const element = track?.elements.find(({ id }) => id === clip.elementId);
	if (!track || element?.type !== "video") return null;

	const share = Math.min(SPLIT_LIMITS.max, Math.max(SPLIT_LIMITS.min, split));
	const top = { top: 0, height: Math.round(canvas.height * share) };
	const bottom = { top: top.height, height: canvas.height - top.height };
	const gameClip = placed(element, framePart({ part: game, window: top, media, canvas }), windowMask({ ...top, canvasHeight: canvas.height }));
	const facecamPlaced = placed(element, framePart({ part: facecam, window: bottom, media, canvas }), windowMask({ ...bottom, canvasHeight: canvas.height }));
	const facecamClip: VideoElement = {
		...facecamPlaced,
		id: generateUUID(),
		name: names.facecamClip(element.name),
		// One sound: the game clip keeps it.
		params: { ...facecamPlaced.params, muted: true },
		agentId: facecamAgentId,
		humanFields: undefined,
	};
	const facecamTrack: VideoTrack = { id: generateUUID(), name: names.facecamTrack, type: "video", muted: false, hidden: false, elements: [facecamClip] };

	const replace = <T extends TimelineTrack>(candidate: T): T =>
		candidate.id === track.id
			? { ...candidate, elements: candidate.elements.map((item) => (item.id === element.id ? gameClip : item)) } as T
			: candidate;
	return {
		tracks: {
			// On top of everything, so the facecam window is never covered by the game.
			overlay: [facecamTrack, ...tracks.overlay.map(replace)],
			main: replace(tracks.main),
			audio: tracks.audio.map(replace),
		},
		game: { trackId: track.id, elementId: element.id },
		facecam: { trackId: facecamTrack.id, elementId: facecamClip.id },
	};
}
