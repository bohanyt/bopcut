import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { getVisibleElementsWithBounds, type ElementBounds } from "@/preview/element-bounds";
import { getMaskDefinition } from "@/masks";
import type { BookmarkBox } from "@/timeline/bookmarks/area";
import { TICKS_PER_SECOND } from "@/wasm";
import { getReachableScenes } from "./scene-graph";
import { getElementLocalTime } from "@/animation";
import { resolveOpacityAtTime } from "@/animation/values";
import { presetLayerAt, readPresetSettings } from "@/animation/presets";
import { readOpacityFromParams } from "@/rendering";

export function validNote(text: unknown, start: unknown, end: unknown): boolean {
	return typeof text === "string" && !!text.trim() && typeof start === "number" && Number.isFinite(start) && start >= 0 && (end === undefined || (typeof end === "number" && Number.isFinite(end) && end >= start));
}

export const noteId = (bookmark: Bookmark) => bookmark.id ?? `legacy-${bookmark.time}`;

export function elementsInNoteBox(box: BookmarkBox, time: number, tracks: SceneTracks, canvasSize: { width: number; height: number }, mediaAssets: MediaAsset[]) {
	const { width, height } = canvasSize;
	const target = { cx: (box.x + box.width / 2) * width, cy: (box.y + box.height / 2) * height, width: box.width * width, height: box.height * height };
	return getVisibleElementsWithBounds({ tracks, currentTime: time, canvasSize, mediaAssets, includeCompound: true })
		.reverse().filter(({ bounds, element }) => {
			if (!rectanglesOverlap(bounds, target)) return false;
			const localTime = getElementLocalTime({ timelineTime: time, elementStartTime: element.startTime, elementDuration: element.duration });
			const opacity = resolveOpacityAtTime({ baseOpacity: readOpacityFromParams({ params: element.params }), animations: element.animations, localTime });
			if (opacity <= 0 || presetLayerAt(readPresetSettings(element.params), localTime, element.duration, height).opacity <= 0) return false;
			const mask = "masks" in element ? element.masks?.[0] : undefined;
			if (!mask) return true;
			const definition = getMaskDefinition(mask.type);
			if (definition.isActive?.(mask.params) === false) return true;
			const surface = document.createElement("canvas");
			surface.width = surface.height = 96;
			const ctx = surface.getContext("2d", { willReadFrequently: true });
			if (!ctx) return true;
			const { body } = definition.renderer;
			// Analytic masks already apply feather. The renderer's distance pass extends
			// coverage for the other masks by half the feather distance past the edge.
			const feather = body.kind === "drawWithFeather" ? 0 : mask.params.feather / 2;
			const halfW = target.width / 2, halfH = target.height / 2;
			const stepX = (target.width + 2 * feather) / 96, stepY = (target.height + 2 * feather) / 96;
			ctx.scale(1 / stepX, 1 / stepY);
			ctx.translate(bounds.cx - target.cx + halfW + feather, bounds.cy - target.cy + halfH + feather);
			ctx.rotate(bounds.rotation * Math.PI / 180);
			const w = Math.abs(bounds.width), h = Math.abs(bounds.height);
			ctx.translate(-w / 2, -h / 2);
			ctx.beginPath();
			ctx.rect(0, 0, w, h);
			ctx.clip();
			const args = { ctx, width: w, height: h, resolvedParams: mask.params };
			ctx.fillStyle = "white";
			if (body.kind === "fillPath") ctx.fill(body.buildPath(args));
			else if (body.kind === "drawOpaque") body.drawOpaque(args);
			else body.drawWithFeather({ ...args, feather: mask.params.feather });
			if (mask.params.inverted) {
				ctx.globalCompositeOperation = "source-out";
				ctx.fillStyle = "white";
				ctx.fillRect(0, 0, w, h);
			}
			const { data } = ctx.getImageData(0, 0, 96, 96);
			for (let i = 0; i < 96 * 96; i++) {
				if (data[i * 4 + 3] === 0) continue;
				const dx = Math.max(0, Math.abs((i % 96 + 0.5) * stepX - halfW - feather) - halfW);
				const dy = Math.max(0, Math.abs((Math.floor(i / 96) + 0.5) * stepY - halfH - feather) - halfH);
				if (Math.hypot(dx, dy) <= feather) return true;
			}
			return false;
		}).map(({ element }) => ({ id: element.id, name: element.name, type: element.type }));
}

function rectanglesOverlap(a: ElementBounds, b: Omit<ElementBounds, "rotation">): boolean {
	const x = b.cx - a.cx, y = b.cy - a.cy;
	const w = Math.abs(a.width) / 2, h = Math.abs(a.height) / 2;
	const u = b.width / 2, v = b.height / 2;
	const angle = a.rotation * Math.PI / 180;
	const c = Math.cos(angle), s = Math.sin(angle), ac = Math.abs(c), as = Math.abs(s);
	return w > 0 && h > 0 && Math.abs(x) < w * ac + h * as + u && Math.abs(y) < w * as + h * ac + v &&
		Math.abs(x * c + y * s) < w + u * ac + v * as && Math.abs(-x * s + y * c) < h + u * as + v * ac;
}

export function snapshotNotes(root: TScene, scenes: TScene[], canvas: { width: number; height: number }, media: MediaAsset[]) {
	return getReachableScenes(scenes, root.id).flatMap((scene) =>
		scene.bookmarks.filter((b) => b.note?.trim() && (scene === root || b.box)).map((b) => {
			const elements = b.box ? elementsInNoteBox(b.box, b.time, scene.tracks, canvas, media) : undefined;
			return {
				id: noteId(b), text: b.note, start: b.time / TICKS_PER_SECOND,
				...(b.duration ? { end: (b.time + b.duration) / TICKS_PER_SECOND } : {}),
				elementIds: b.elementIds ?? [], replies: b.replies ?? [], author: b.author ?? "user",
				resolved: b.resolved ?? false, createdAt: b.createdAt ?? null,
				...(b.box && { sceneId: scene.id, box: b.box, elements }),
			};
		}),
	);
}
