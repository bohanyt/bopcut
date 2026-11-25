import { getChannelEntriesFromData } from "@/animation/channel-data";
import { getScalarChannelValueAtTime } from "@/animation/interpolation";
import type { ScalarAnimationKey } from "@/animation/types";
import type { CompoundElement, TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks, toRootInterval } from "./scene-graph";

export const draftThresholds = { position: 0.04, scale: 0.06, rotation: 10, opacity: 0.15 };
export type DraftThresholds = typeof draftThresholds;
type Canvas = { width: number; height: number };
type Address = { trackId: string; id: string; path?: string[]; agentId?: string };
type Clip = { from: number; to: number; address: Address };
type Item = { element: TimelineElement; clip: Clip; lane: string; origin: number; slideDuration?: number };
type Shot = { clip: Clip; mediaId: string };
type Source = {
	mediaId: string; uses: number; from: number; to: number; seconds: number; shortestGap: number | null;
	share: number; clips: Clip[]; omittedClips: number;
};
type Run = { kind: "same-source-run"; from: number; to: number; mediaId: string; uses: number; clips: Clip[]; omittedClips: number };
type Motion = {
	kind: "keyframe-jump" | "speed-change" | "peak-speed" | "motion-at-start" | "motion-at-end";
	at: number; clip: Clip; property: string; unit: string; change: number; threshold: number;
	before?: number; after?: number; keyIds: string[];
};

const samplesPerRow = 5;
const maxItems = 50_000;
const maxCurveFrames = 100_000;
const transitionSuffix = /~(?:crossfade|slide-left|flash|dip)$/;
const rounded = (value: number) => Number(value.toFixed(6));
const seconds = (ticks: number) => rounded(ticks / TICKS_PER_SECOND);
const disabled = (value: object) => ("disabled" in value && value.disabled === true) || ("enabled" in value && value.enabled === false);
function hidden(element: TimelineElement) {
	return disabled(element) || ("hidden" in element && element.hidden) ||
		(element.params?.opacity === 0 && !element.animations?.opacity);
}

function* timelineItems(root: TScene, scenes: TScene[], signal: AbortSignal, visit: { truncated: boolean }): Generator<Item> {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	let count = 0;
	function* walk(scene: TScene, chain: CompoundElement[], ancestors: ReadonlySet<string>, hostLane?: string): Generator<Item> {
		if (ancestors.has(scene.id)) return;
		if (chain.length > 32) { visit.truncated = true; return; }
		const seen = new Set(ancestors).add(scene.id);
		const path = chain.map((part) => part.id);
		const shift = chain.reduce((sum, part) => sum + part.startTime - part.trimStart, 0);
		const tracks = orderedTracks(scene.tracks);
		const slides = new Map<string, number>();
		for (const track of tracks) for (const part of track.elements) {
			const suffix = "~slide-left";
			if (part.agentId?.endsWith(suffix)) slides.set(JSON.stringify([part.agentId.slice(0, -suffix.length), part.startTime]), part.duration);
		}
		for (const track of tracks) {
			if (track.type === "audio" || disabled(track) || track.hidden) continue;
			const lane = track === scene.tracks.main && hostLane ? hostLane : JSON.stringify([...path, track.id]);
			for (const element of track.elements) {
				signal.throwIfAborted();
				if (++count > maxItems) { visit.truncated = true; return; }
				if (hidden(element) || transitionSuffix.test(element.agentId ?? "")) continue;
				const interval = toRootInterval(element.startTime, element.startTime + element.duration, chain);
				if (!interval) continue;
				const address = { trackId: track.id, id: element.id, ...(path.length && { path }), ...(element.agentId && { agentId: element.agentId }) };
				const slideDuration = slides.get(JSON.stringify([element.agentId ?? element.id, element.startTime]));
				yield { element, origin: shift + element.startTime, lane, slideDuration, clip: { from: interval[0], to: interval[1], address } };
				if (element.type === "compound") {
					const child = byId.get(element.sceneId);
					if (child) yield* walk(child, [...chain, element], seen, lane);
				}
				if (count > maxItems) return;
			}
		}
	}
	yield* walk(root, [], new Set());
}

function add<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const current = map.get(key);
	if (current) current.push(value);
	else map.set(key, [value]);
}

const clipOrder = (a: Clip, b: Clip) => a.from - b.from || a.to - b.to;
const outputClip = ({ from, to, address }: Clip) => ({ from: seconds(from), to: seconds(to), address });
const clipSample = (shots: Shot[]) => ({
	clips: shots.slice(0, samplesPerRow).map(({ clip }) => outputClip(clip)),
	omittedClips: Math.max(0, shots.length - samplesPerRow),
});

function sourceSummary(mediaId: string, shots: Shot[], duration: number): Source {
	shots.sort((a, b) => clipOrder(a.clip, b.clip));
	const first = shots[0].clip;
	let edge = first.to, total = first.to - first.from;
	let gap = Infinity;
	for (const { clip } of shots.slice(1)) {
		gap = Math.min(gap, Math.max(0, clip.from - edge));
		total += Math.max(0, clip.to - Math.max(edge, clip.from));
		edge = Math.max(edge, clip.to);
	}
	return { mediaId, uses: shots.length, from: seconds(first.from), to: seconds(edge), seconds: seconds(total),
		shortestGap: Number.isFinite(gap) ? seconds(gap) : null, share: duration ? rounded(total / duration) : 0, ...clipSample(shots) };
}

function sameSourceRuns(shots: Shot[]): Run[] {
	shots.sort((a, b) => clipOrder(a.clip, b.clip));
	const runs: Run[] = [];
	for (let first = 0, next = 1; first < shots.length; first = next, next++) {
		while (next < shots.length && shots[next].mediaId === shots[first].mediaId && shots[next - 1].clip.to === shots[next].clip.from) next++;
		if (next - first > 1) runs.push({ kind: "same-source-run", mediaId: shots[first].mediaId, uses: next - first,
			from: seconds(shots[first].clip.from), to: seconds(shots[next - 1].clip.to), ...clipSample(shots.slice(first, next)) });
	}
	return runs;
}

const properties = [
	["transform.positionX", "position", "canvas-share/frame"],
	["transform.positionY", "position", "canvas-share/frame"],
	["transform.scaleX", "scale", "canvas-share/frame"],
	["transform.scaleY", "scale", "canvas-share/frame"],
	["transform.rotate", "rotation", "degrees/frame"],
	["opacity", "opacity", "opacity/frame"],
] as const;

function motionFindings(item: Item, start: number, end: number, ticksPerFrame: number, canvas: Canvas,
	media: Canvas | undefined, thresholds: DraftThresholds, budget: { frames: number; truncated: boolean }): Motion[] {
	const { element, origin, clip, slideDuration } = item;
	const findings: Motion[] = [];
	const fit = media && Math.min(canvas.width / media.width, canvas.height / media.height);
	const tick = (frame: number) => Math.round(frame * ticksPerFrame);
	const frameAtOrAfter = (at: number) => {
		const frame = Math.floor(at / ticksPerFrame);
		return frame + Number(tick(frame) < at);
	};
	const minFrame = frameAtOrAfter(Math.max(start, clip.from));
	const maxFrame = frameAtOrAfter(Math.min(end, clip.to)) - 1;
	for (const [property, category, unit] of properties) {
		const isY = property.endsWith("Y");
		const size = isY ? canvas.height : canvas.width;
		const factor = category === "position" ? 1 / size :
			category === "scale" && media && fit ? fit * (isY ? media.height : media.width) / size : 1;
		for (const [, channel] of getChannelEntriesFromData({ data: element.animations?.[property] })) {
			const keys = channel.keys.filter((key): key is ScalarAnimationKey =>
				typeof key.value === "number" && Number.isFinite(key.value) && Number.isSafeInteger(key.time))
				.sort((a, b) => a.time - b.time);
			if (keys.length < 2) continue;
			const emit = (kind: Motion["kind"], at: number, change: number, ids: ScalarAnimationKey[], before?: number, after?: number) => {
				if (!Number.isFinite(change) || Math.abs(change) < thresholds[category]) return;
				findings.push({ kind, at: seconds(at), clip: outputClip(clip), property, unit, change: rounded(change),
					threshold: thresholds[category], keyIds: ids.map(({ id }) => id),
					...(before !== undefined && { before: rounded(before) }), ...(after !== undefined && { after: rounded(after) }) });
			};
			const extrapolation = "extrapolation" in channel ? channel.extrapolation : undefined;
			// Slide-left records an incoming pair at 0 and the continuation's duration.
			// Match the recorded interval by identity and timing, independent of parameter values.
			const slide = property === "transform.positionX" && slideDuration && keys.some(key => key.time === 0) &&
				keys.some(key => key.time === slideDuration) ? slideDuration : 0;
			const valueAt = (frame: number) => {
				const time = tick(frame) - origin;
				let low = 0, high = keys.length - 1;
				while (low < high) {
					const middle = (low + high) >>> 1;
					if (keys[middle].time < time) low = middle + 1;
					else high = middle;
				}
				const offset = Math.max(0, low - 1);
				// The renderer's evaluator only needs the two keys bracketing an interior sample.
				return getScalarChannelValueAtTime({ channel: { keys: keys.slice(offset, offset + 2), extrapolation },
					time, fallbackValue: keys[0].value });
			};
			const delta = (left: number) => {
				if (left < minFrame || left + 1 > maxFrame || (slide && tick(left) - origin < slide)) return;
				return (valueAt(left + 1) - valueAt(left)) * factor;
			};
			const reported = new Set<number>();
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i], prev = keys[i - 1], next = keys[i + 1];
				const at = origin + key.time;
				const frame = frameAtOrAfter(at);
				if (prev?.segmentToNext === "bezier") {
					const first = Math.max(minFrame, frameAtOrAfter(origin + prev.time));
					let peak = 0, peakFrame = first;
					for (let sample = first; sample + 1 <= Math.min(frame, maxFrame) && tick(sample + 1) <= at; sample++) {
						if (--budget.frames < 0) { budget.truncated = true; break; }
						const amount = delta(sample);
						if (amount !== undefined && Math.abs(amount) > Math.abs(peak)) { peak = amount; peakFrame = sample; }
					}
					emit("peak-speed", tick(peakFrame + 1), peak, [prev, key]);
				}
				if (at < start || at >= end || at <= clip.from || at >= clip.to || (slide && key.time <= slide)) continue;
				if (prev && (prev.segmentToNext === "step" || key.time - prev.time <= ticksPerFrame + 1)) {
					let change = delta(frame - 1);
					if (change === undefined) continue;
					if (category === "rotation" && prev.segmentToNext === "step") change = ((((change + 180) % 360) + 360) % 360) - 180;
					if (Math.abs(change) >= thresholds[category]) {
						if (!reported.has(frame)) emit("keyframe-jump", tick(frame), change, [prev, key]);
						reported.add(frame);
						continue;
					}
					if (prev.segmentToNext === "step") continue;
				}
				const before = delta(frame - (tick(frame) === at ? 1 : 2));
				const after = delta(frame);
				if (before !== undefined && after !== undefined && Math.abs(after - before) >= thresholds[category] && !reported.has(frame)) {
					emit("speed-change", tick(frame), after - before, [prev, key, next].filter(Boolean), before, after);
					reported.add(frame);
				}
			}
			const edge = (at: number, entering: boolean) => {
				if (at < start || at > end || at === (entering ? end : start)) return;
				const frame = entering ? minFrame : maxFrame - 1;
				const velocity = delta(frame);
				if (velocity === undefined) return;
				const key = keys.findIndex(entry => entry.time >= tick(frame + 1) - origin);
				const adjacent = key < 0 ? keys.slice(-2) : keys.slice(Math.max(0, key - 1), key + 1);
				emit(entering ? "motion-at-start" : "motion-at-end", at, entering ? velocity : -velocity, adjacent,
					entering ? 0 : velocity, entering ? velocity : 0);
			};
			edge(clip.from, true);
			edge(clip.to, false);
		}
	}
	return findings;
}

export function inspectDraft({ root, scenes, media, from, to, canvas, fps, thresholds = draftThresholds, signal }: {
	root: TScene; scenes: TScene[]; media: { id: string; width?: number; height?: number }[];
	from: number; to: number; canvas: Canvas; fps: number; thresholds?: DraftThresholds; signal: AbortSignal;
}) {
	const start = Math.round(from * TICKS_PER_SECOND), end = Math.round(to * TICKS_PER_SECOND);
	const assets = new Map(media.map((asset) => [asset.id, asset]));
	const sources = new Map<string, Shot[]>(), lanes = new Map<string, Shot[]>();
	const visit = { truncated: false };
	const budget = { frames: maxCurveFrames, truncated: false };
	const motion: Motion[] = [];
	for (const item of timelineItems(root, scenes, signal, visit)) {
		const { element, clip, lane } = item;
		if (clip.from >= end || clip.to <= start) continue;
		const asset = "mediaId" in element ? assets.get(element.mediaId) : undefined;
		const size = asset?.width && asset.height && asset.width > 0 && asset.height > 0 ? { width: asset.width, height: asset.height } : undefined;
		if (element.type === "video" || element.type === "image") {
			const shot = { mediaId: element.mediaId, clip: { ...clip, from: Math.max(start, clip.from), to: Math.min(end, clip.to) } };
			add(sources, shot.mediaId, shot);
			add(lanes, lane, shot);
		}
		if (element.animations && element.type !== "effect" && element.type !== "audio") {
			for (const finding of motionFindings(item, start, end, TICKS_PER_SECOND / fps, canvas, size, thresholds, budget)) motion.push(finding);
		}
	}
	return {
		sceneId: root.id, from: seconds(start), to: seconds(end), thresholds, incomplete: visit.truncated || budget.truncated,
		sources: [...sources].map(([id, shots]) => sourceSummary(id, shots, end - start))
			.sort((a, b) => b.uses - a.uses || b.seconds - a.seconds || a.from - b.from),
		runs: [...lanes.values()].flatMap(sameSourceRuns).sort((a, b) => a.from - b.from),
		motion: motion.sort((a, b) => a.at - b.at),
	};
}

export type DraftReport = ReturnType<typeof inspectDraft>;

export function formatDraftReport(report: DraftReport, json: boolean, all = false) {
	const { sources, runs, motion, ...header } = report;
	const omitted = { sources: 0, runs: 0, motion: 0 };
	const sceneId = header.sceneId.length > 128 ? header.sceneId.slice(0, 128) + "…" : header.sceneId;
	const singleUseSources = sources.filter(source => source.uses === 1).length;
	const output = { ...header, sceneId, singleUseSources, sources: [] as Source[], runs: [] as Run[], motion: [] as Motion[], omitted };
	const title = `Draft check ${header.from}–${header.to} s in ${JSON.stringify(sceneId)}${header.incomplete ? " (partial traversal)" : ""}`;
	const lines = [title, `Single-use sources: ${singleUseSources}`];
	// Independent budgets leave space for motion and runs even in projects with many unique files.
	const append = <T>(key: keyof typeof omitted, input: T[], target: T[], budget: number) => {
		for (const row of input) {
			const line = json ? JSON.stringify(row) : `${key}: ${JSON.stringify(row)}`;
			budget -= Buffer.byteLength(line) + 1;
			if (budget < 0) break;
			target.push(row);
			if (!json) lines.push(line);
		}
		omitted[key] = input.length - target.length;
	};
	append("sources", json || all ? sources : sources.filter(source => source.uses > 1), output.sources, 6_500);
	append("runs", runs, output.runs, 4_000);
	append("motion", motion, output.motion, 8_000);
	if (json) return output;
	lines.push(`Omitted rows: ${omitted.sources} sources, ${omitted.runs} runs, ${omitted.motion} motion.`);
	return lines.join("\n") + "\n";
}
