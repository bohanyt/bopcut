import { createCanvas } from "@napi-rs/canvas";
import { getChannelsFromData } from "@/animation/channel-data";
import { presetLayerAt, readPresetSettings } from "@/animation/presets";
import { resolveOpacityAtTime } from "@/animation/values";
import { parseSourceWords } from "@/media/words";
import { getElementBounds, type ElementBounds } from "@/preview/element-bounds";
import { buildTransformFromParams, readOpacityFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { peakShakeIntensity, readShakeSettings } from "@/rendering/shake";
import { getEffectiveRateAt } from "@/retime/resolve";
import { textNumber } from "@/text/style";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { collectAudibleCandidates } from "@/media/audio";
import type { MediaType } from "@/media/types";
import { SUPPORTS_AUDIO } from "@/media/media-utils";
import { getElementFades, isElementMuted, resolveEffectiveAudioGain } from "@/timeline/audio-state";
import type { TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { timelineTranscript, type TranscriptMedia } from "./packed-transcript";
import { visibleRangeElements } from "./range-view-project";
import { finding, REVIEW_LIMITS as L, unusualPauses, type ReviewFinding } from "./review-findings";

type Canvas = { width: number; height: number };
export type ReviewMedia = TranscriptMedia & { width?: number; height?: number; fileType?: string; present?: boolean; sourceFile?: string; type?: MediaType };
type Instance = ReturnType<typeof visibleRangeElements> extends Generator<infer T> ? T : never;
const instanceKey = (item: Instance) => [...item.chain.map((parent) => parent.id), item.element.id].join("/");
type Rect = { x: number; y: number; w: number; h: number };
const normalized = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
const intersects = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
	Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const geometry = (b: Rect, canvas: Canvas, sampledAt: number) => ({
	boundsX: b.x, boundsY: b.y, boundsWidth: b.w, boundsHeight: b.h, canvasWidth: canvas.width, canvasHeight: canvas.height, sampledAt,
});
const localSeconds = (element: TimelineElement, at: number) => at - element.startTime / TICKS_PER_SECOND;
const transformAt = (element: TimelineElement, localTime: number) =>
	resolveTransformAtTime({ baseTransform: buildTransformFromParams({ params: element.params }), animations: element.animations, localTime });
const opacityAt = (element: TimelineElement, localTime: number, height: number) =>
	resolveOpacityAtTime({ baseOpacity: readOpacityFromParams({ params: element.params }), animations: element.animations, localTime }) *
	presetLayerAt(readPresetSettings(element.params), localTime, element.duration, height).opacity;

export function reviewOpacity(item: Instance, at: number, height: number) {
	let ticks = at * TICKS_PER_SECOND;
	let opacity = 1;
	for (const parent of item.chain) {
		const local = ticks - parent.startTime;
		opacity *= opacityAt(parent, local, height);
		ticks = local + parent.trimStart;
	}
	return opacity * opacityAt(item.element, ticks - item.element.startTime, height);
}

function sampleTimes(from: number, to: number, fps: number) {
	const count = Math.min(13, Math.max(2, Math.ceil((to - from) * fps)));
	return Array.from({ length: count }, (_, i) => from + (to - from) * (i + 0.5) / count);
}

export function textFindings(samples: { at: number; bounds: Rect; fontPx: number; opacity: number }[], dimensions: Canvas,
	from: number, to: number, id: string, content: string, followsSpeech: boolean): ReviewFinding[] {
	const visible = samples.filter((sample) => sample.opacity >= 0.9);
	if (!visible.length) return [];
	const { width, height } = dimensions;
	const portrait = height > width;
	const smallest = Math.min(...visible.map(({ fontPx }) => fontPx * (portrait ? L.portraitWidth : L.landscapeWidth) / width));
	const inset = ({ bounds: b }: typeof visible[number]) => Math.min(b.x / width, b.y / height, 1 - (b.x + b.w) / width, 1 - (b.y + b.h) / height);
	const edge = visible.reduce((a, b) => inset(a) < inset(b) ? a : b);
	const margin = inset(edge);
	const measured = geometry(edge.bounds, dimensions, edge.at);
	const result: ReviewFinding[] = [];
	if (margin < L.margin) result.push(finding("text-at-edge", "warning", from, to, { margin, threshold: L.margin, ...measured }, [id]));
	else if (portrait && visible.some(({ bounds: b }) => b.x + b.w > width * (1 - L.overlayRight) || b.y < height * L.overlayTop || b.y + b.h > height * (1 - L.overlayBottom))) {
		result.push(finding("text-in-app-overlay", "info", from, to, { bottom: L.overlayBottom, right: L.overlayRight, top: L.overlayTop }, [id]));
	}
	if (smallest < L.phoneTextPx) result.push(finding("small-text", "warning", from, to, { displayPixels: smallest, threshold: L.phoneTextPx, ...measured }, [id]));
	const characters = [...content.trim()].length;
	const needed = Math.max(L.minReadSeconds, characters / L.readCharsPerSecond);
	if (!followsSpeech && to - from + 1e-8 < needed) {
		result.push(finding("short-text", "warning", from, to, { seconds: to - from, needed, characters, ...measured }, [id]));
	}
	return result;
}

function projectBounds(bounds: ElementBounds, canvas: Canvas, parents: ReturnType<typeof transformAt>[]) {
	const project = (x: number, y: number, scaleX: number, scaleY: number, rotate: number) => {
		const radians = rotate * Math.PI / 180;
		return { x: x * scaleX * Math.cos(radians) - y * scaleY * Math.sin(radians),
			y: x * scaleX * Math.sin(radians) + y * scaleY * Math.cos(radians) };
	};
	const points = [-1, 1].flatMap((a) => [-1, 1].map((b) => {
		const q = project(a * bounds.width / 2, b * bounds.height / 2, 1, 1, bounds.rotation);
		let x = q.x + bounds.cx, y = q.y + bounds.cy;
		for (const layer of parents) {
			const p = project(x - canvas.width / 2, y - canvas.height / 2, layer.scaleX, layer.scaleY, layer.rotate);
			x = p.x + canvas.width / 2 + layer.position.x;
			y = p.y + canvas.height / 2 + layer.position.y;
		}
		return { x, y };
	}));
	const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
	return { x, y, w: Math.max(...points.map((p) => p.x)) - x, h: Math.max(...points.map((p) => p.y)) - y };
}

/** Source rectangle visible through the canvas for a static axis-aligned placement. */
export function reviewSourceCrop(item: Instance, canvas: Canvas, media: ReviewMedia) {
	const { element, chain } = item;
	if ((element.type !== "video" && element.type !== "image") || !media.width || !media.height) return null;
	const transform = buildTransformFromParams({ params: element.params });
	if (!transform.scaleX || !transform.scaleY || transform.rotate) return null;
	// A compound is rasterized to its parent canvas before its own transform is applied.
	if (chain.some((parent) => {
		const { rotate, scaleX, scaleY, position } = buildTransformFromParams({ params: parent.params });
		const shake = readShakeSettings(parent.params);
		return rotate || scaleX !== 1 || scaleY !== 1 || position.x || position.y ||
			(shake && peakShakeIntensity(shake, parent.animations)) || shake?.rotation;
	})) return null;
	if ([...chain, element].some((part) =>
		Object.keys(part.animations ?? {}).some((key) => key.startsWith("transform")) ||
			("masks" in part && part.masks?.length) || ("effects" in part && part.effects?.length) ||
			(part.params.blendMode && part.params.blendMode !== "normal") ||
			(part.params["animation.in"] && part.params["animation.in"] !== "none") ||
			(part.params["animation.out"] && part.params["animation.out"] !== "none")
	)) return null;
	const bounds = getElementBounds({ element, canvasSize: canvas, localTime: 0, mediaAsset: media });
	if (!bounds) return null;
	const placed = projectBounds(bounds, canvas, []);
	const x0 = Math.max(0, placed.x), x1 = Math.min(canvas.width, placed.x + placed.w);
	const y0 = Math.max(0, placed.y), y1 = Math.min(canvas.height, placed.y + placed.h);
	if (x1 <= x0 || y1 <= y0) return null;
	const x = Math.max(0, Math.ceil((x0 - placed.x) / placed.w * media.width - 1e-8));
	const y = Math.max(0, Math.ceil((y0 - placed.y) / placed.h * media.height - 1e-8));
	const right = Math.min(media.width, Math.floor((x1 - placed.x) / placed.w * media.width + 1e-8));
	const bottom = Math.min(media.height, Math.floor((y1 - placed.y) / placed.h * media.height + 1e-8));
	if (right <= x || bottom <= y) return null;
	return { x: transform.scaleX < 0 ? media.width - right : x, y: transform.scaleY < 0 ? media.height - bottom : y,
		width: right - x, height: bottom - y, coverage: (x1 - x0) * (y1 - y0) / (canvas.width * canvas.height) };
}

export function inspectTimeline(root: TScene, scenes: TScene[], media: ReviewMedia[], canvas: Canvas, duration: number, fps: number,
	{ from: windowStart, to: windowEnd } = { from: 0, to: duration }) {
	const assets = new Map(media.map((asset) => [asset.id, asset]));
	const instances = Array.from(visibleRangeElements(root, scenes, { from: windowStart, to: windowEnd, rows: 1 }),
		(item) => ({ ...item, start: Math.max(item.start, windowStart), end: Math.min(item.end, windowEnd) }));
	const instancesByKey = new Map(instances.map((item) => [instanceKey(item), item]));
	const sounds = collectAudibleCandidates({ tracks: root.tracks, scenes, rangeStart: windowStart * TICKS_PER_SECOND,
		duration: windowEnd * TICKS_PER_SECOND, mediaAssets: media.filter((asset) => asset.present !== false)
		.map((asset) => ({ ...asset, type: asset.type ?? "audio" as const })) }).flatMap(({ element, mediaAsset }) => {
			if (isElementMuted({ element })) return [];
			if (!(element.type === "audio" && element.sourceType === "library") && (!mediaAsset || !SUPPORTS_AUDIO.includes(mediaAsset.type))) return [];
			const mediaId = "mediaId" in element ? element.mediaId : element.sourceUrl;
			const rate = getEffectiveRateAt({ retime: element.retime });
			const from = element.startTime / TICKS_PER_SECOND, length = element.duration / TICKS_PER_SECOND;
			if (length <= 0) return [];
			const src = element.trimStart / TICKS_PER_SECOND;
			const gain = (localTime: number) => resolveEffectiveAudioGain({ element, localTime });
			const gainPoints = getChannelsFromData({ data: element.animations?.volume })
				.flatMap(({ keys }) => keys.map(({ time }) => time / TICKS_PER_SECOND));
			const { fadeIn, fadeOut } = getElementFades({ element });
			if (fadeIn > 0) gainPoints.push(fadeIn);
			if (fadeOut > 0) gainPoints.push(length - fadeOut);
			gainPoints.sort((a, b) => a - b);
			const minimumGain = (start: number, end: number) => {
				if (!gainPoints.length) return gain(start);
				let minimum = Math.min(gain(start), gain((start + end) / 2), gain(end));
				let low = 0, high = gainPoints.length;
				while (low < high) {
					const middle = (low + high) >>> 1;
					if (gainPoints[middle] <= start) low = middle + 1;
					else high = middle;
				}
				for (let i = low; i < gainPoints.length && gainPoints[i] < end; i++) {
					minimum = Math.min(minimum, gain(gainPoints[i]));
				}
				return minimum;
			};
			return [{ element, mediaId, from, to: from + length, src, srcEnd: src + length * rate,
				rate, minimumGain,
				audible: (time: number) => time >= from && time <= from + length && gain(time - from) > 0.001 }];
	});
	const cuts = new Map<number, Set<string>>();
	const addCut = (time: number, id: string) => {
		if (time <= windowStart + 1e-8 || time >= windowEnd - 1e-8) return;
		const stamp = Math.round(time * TICKS_PER_SECOND) / TICKS_PER_SECOND;
		const ids = cuts.get(stamp) ?? new Set<string>();
		ids.add(id); cuts.set(stamp, ids);
	};
	const findings: ReviewFinding[] = [];
	const mutedTracks = new Set<string>();
	for (const { element, track, start, end } of instances) {
		if (element.type === "audio" || element.type === "video" || element.type === "image" || element.type === "compound") {
			addCut(start, element.id); addCut(end, element.id);
		}
		if ("mediaId" in element && assets.get(element.mediaId)?.present === false) {
			findings.push(finding("missing-media", "error", start, end, { mediaId: element.mediaId }, [element.id]));
		}
		if ("muted" in track && track.muted && !mutedTracks.has(track.id)) {
			mutedTracks.add(track.id);
			findings.push(finding("muted-track", "info", start, end, { trackId: track.id, elements: track.elements.length }, track.elements.map((clip) => clip.id)));
		}
	}
	const wordCuts = new Set<string>();
	for (const sound of sounds) {
		const words = parseSourceWords(assets.get(sound.mediaId)?.words) ?? [];
		for (const entering of [true, false]) {
			const at = entering ? sound.from : sound.to;
			if (at < windowStart || at > windowEnd) continue;
			const source = entering ? sound.src : sound.srcEnd;
			if (!sound.audible(at + (entering ? 0.005 : -0.005))) continue;
			const word = words.find((w) => w.start + 0.001 < source && source < w.end - 0.001);
			if (!word) continue;
			const continued = sounds.some((other) => other !== sound && other.mediaId === sound.mediaId &&
				Math.abs((entering ? other.to : other.from) - at) < 1e-5 &&
				Math.abs((entering ? other.srcEnd : other.src) - source) < 0.005 &&
				other.audible(at + (entering ? -0.005 : 0.005)));
			if (continued) continue;
			const missing = entering ? source - word.start : word.end - source;
			const key = `${at}:${sound.mediaId}:${word.start}`;
			if (wordCuts.has(key)) continue;
			wordCuts.add(key);
			const placed = instancesByKey.get(sound.element.id);
			findings.push(finding("cut-word", missing > L.clippedWordSeconds ? "warning" : "info", at, at,
				{ word: word.text, sourceCut: source, wordStart: word.start, wordEnd: word.end, missing, threshold: L.clippedWordSeconds,
					instance: sound.element.id }, [placed?.element.id ?? sound.element.id]));
		}
	}
	const words = timelineTranscript(root, scenes, media, { from: windowStart, to: windowEnd, groupWords: false }).flatMap((clip) =>
		clip.phrases.filter((word) => sounds.some((sound) => sound.element.id === clip.id &&
			sampleTimes(word.start, word.end, fps).some(sound.audible))).map((word) => ({ ...word, clipId: clip.id })))
		.sort((a, b) => a.start - b.start);
	findings.push(...unusualPauses(words.map((word) => ({ from: word.start, to: word.end }))));

	const clips = instances.filter(({ element }) => element.type === "video" || element.type === "image" || element.type === "audio");
	const byMedia = new Map<string, Array<{ instance: Instance; start: number; end: number }>>();
	for (const instance of clips.sort((a, b) => a.start - b.start)) {
		const { element } = instance;
		if (!("mediaId" in element)) continue;
		const shift = instance.chain.reduce((sum, item) => sum + (item.startTime - item.trimStart) / TICKS_PER_SECOND, 0);
		const rate = getEffectiveRateAt({ retime: "retime" in element ? element.retime : undefined });
		const start = element.trimStart / TICKS_PER_SECOND + localSeconds(element, instance.start - shift) * rate;
		const end = start + (instance.end - instance.start) * rate;
		const entries = byMedia.get(element.mediaId) ?? [];
		let related = 0;
		let repeat: ReviewFinding | undefined;
		for (const other of entries) {
			const overlap = Math.min(other.end, end) - Math.max(other.start, start);
			if (overlap < L.repeatSeconds || overlap < L.repeatFraction * Math.max(end - start, other.end - other.start)) continue;
			const gap = Math.abs(instance.start - other.instance.start);
			const heard = [instance, other.instance].every((item) => sounds.some((sound) => sound.element.id === instanceKey(item) && sound.audible((item.start + item.end) / 2)));
			const severity = heard && gap <= L.nearbyRepeatSeconds ? "warning" : "info";
			related++;
			if (repeat?.severity === "warning" && severity === "info") continue;
			repeat = finding("repeated-source", severity, instance.start, instance.end,
				{ mediaId: element.mediaId, sourceStart: start, sourceEnd: end, otherSourceStart: other.start, otherSourceEnd: other.end, overlap, gap, heard },
				[other.instance.element.id, element.id]);
		}
		if (repeat) { repeat.values.matches = related; findings.push(repeat); }
		entries.push({ instance, start, end });
		byMedia.set(element.mediaId, entries);
	}

	const measure = createCanvas(1, 1).getContext("2d") as unknown as CanvasRenderingContext2D;
	const sample = (item: Instance, at: number) => {
		let ticks = at * TICKS_PER_SECOND;
		const levels: ReturnType<typeof transformAt>[] = [];
		let opacity = 1;
		for (const parent of item.chain) {
			const local = ticks - parent.startTime;
			opacity *= opacityAt(parent, local, canvas.height);
			levels.unshift(transformAt(parent, local));
			ticks = local + parent.trimStart;
		}
		const element = item.element;
		const localTime = ticks - element.startTime;
		opacity *= opacityAt(element, localTime, canvas.height);
		const bounds = getElementBounds({ element, canvasSize: canvas, localTime, textContext: measure,
			mediaAsset: "mediaId" in element ? assets.get(element.mediaId) : undefined });
		return bounds && { at, opacity, bounds: projectBounds(bounds, canvas, levels), rotated: bounds.rotation !== 0 || levels.some((level) => level.rotate !== 0),
			fontPx: element.type === "text" ? textNumber(element, "fontSize", 15, localTime) * canvas.height / FONT_SIZE_SCALE_REFERENCE *
				Math.abs(transformAt(element, localTime).scaleY) *
				levels.reduce((scale, level) => scale * Math.abs(level.scaleY), 1) : 0 };
	};
	const texts = instances.filter(({ element }) => element.type === "text");
	for (const item of texts) {
		if (item.element.type !== "text") continue;
		const content = String(item.element.params.content ?? "");
		if (!content.trim()) continue;
		const contentWords = normalized(content);
		const spoken = normalized(words.filter((word) => word.start < item.end + 0.15 && word.end > item.start - 0.15)
			.map((word) => word.text).join(" "));
		const followsSpeech = !!item.element.caption?.words?.length || (!!contentWords && ` ${spoken} `.includes(` ${contentWords} `));
		const samples = sampleTimes(item.start, item.end, fps).flatMap((at) => sample(item, at) ?? []);
		findings.push(...textFindings(samples, canvas, item.start, item.end, item.element.id, content, followsSpeech));
		const layer = instances.indexOf(item);
		for (let i = 0; i < layer; i++) {
			const other = instances[i];
			if (other.element.type !== "text" && other.element.type !== "image" && other.element.type !== "video") continue;
			const from = Math.max(item.start, other.start), to = Math.min(item.end, other.end);
			if (to - from < 2 / fps - 1e-8) continue;
			const sameGroup = (item.element.groupId && item.element.groupId === other.element.groupId) ||
				(item.chain.length && other.chain.some((parent) => parent.id === item.chain.at(-1)?.id));
			if (other.element.type === "text" && sameGroup) continue;
			const pairs = sampleTimes(from, to, fps).flatMap((time) => {
				const a = sample(item, time), b = sample(other, time);
				if (!a || !b || a.rotated || b.rotated || a.opacity < 0.9 || b.opacity < 0.9) return [];
				const area = intersects(a.bounds, b.bounds);
				const smaller = Math.min(a.bounds.w * a.bounds.h, b.bounds.w * b.bounds.h);
				return [{ smaller: smaller > 0 ? area / smaller : 0, text: a.bounds.w * a.bounds.h > 0 ? area / (a.bounds.w * a.bounds.h) : 0,
					evidence: geometry(a.bounds, canvas, time) }];
			});
			const ids = [item.element.id, other.element.id];
			if (other.element.type === "text") {
				if (normalized(String(other.element.params.content ?? "")) === contentWords && pairs.every((p) => p.smaller >= L.layeredBox)) continue;
				const overlaps = pairs.filter((p) => p.smaller >= L.overlap);
				if (overlaps.length >= 2) findings.push(finding("text-overlap", "warning", from, to,
					{ overlap: Math.max(...overlaps.map((p) => p.smaller)), threshold: L.overlap, samples: overlaps.length, ...overlaps[0].evidence }, ids));
			} else {
				const covered = pairs.filter((p) => p.text >= L.cover);
				if (covered.length < 2) continue;
				const staticOpacity = [item, other].every((entry) => [...entry.chain, entry.element].every((part) => !part.animations &&
					readOpacityFromParams({ params: part.params }) === 1 && !("masks" in part && part.masks?.length) &&
					!("effects" in part && part.effects?.length) && (!part.params.blendMode || part.params.blendMode === "normal") &&
					(!part.params["animation.in"] || part.params["animation.in"] === "none") && (!part.params["animation.out"] || part.params["animation.out"] === "none")));
				const asset = assets.get(other.element.mediaId);
				const opaque = staticOpacity && asset?.present && asset.fileType === "image/jpeg" &&
					covered.length === sampleTimes(from, to, fps).length;
				findings.push(finding("covered-text", opaque ? "warning" : "info", from, to,
					{ coverage: Math.min(...covered.map((p) => p.text)), threshold: L.cover, opaque: !!opaque, ...covered[0].evidence }, ids));
			}
		}
	}
	return { cuts: [...cuts].sort(([a], [b]) => a - b).map(([at, ids]) => ({ at, elementIds: [...ids] })), findings, instances, sounds, words };
}
