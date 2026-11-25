import { getChannelEntriesFromData } from "@/animation/channel-data";
import type { ScalarAnimationKey } from "@/animation/types";
import type { CompoundElement, TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks, toRootInterval } from "./scene-graph";

export const draftThresholds = { position: 0.04, scale: 0.06, rotation: 10, opacity: 0.15 };
export type DraftThresholds = typeof draftThresholds;
type Canvas = { width: number; height: number };
type Address = { trackId: string; id: string; path?: string[]; agentId?: string };
type Clip = { from: number; to: number; address: Address };
type Item = { element: TimelineElement; clip: Clip; lane: string; origin: number };
type Shot = { clip: Clip; mediaId: string };
type Source = {
	mediaId: string; uses: number; from: number; to: number; seconds: number; shortestGap: number | null;
	share: number; clips: Clip[]; omittedClips: number;
};
type Run = { kind: "same-source-run"; from: number; to: number; mediaId: string; uses: number; clips: Clip[]; omittedClips: number };
type Motion = {
	kind: "keyframe-jump" | "speed-change" | "motion-at-start" | "motion-at-end";
	at: number; clip: Clip; property: string; unit: string; change: number; threshold: number;
	before?: number; after?: number; keyIds: string[];
};

const samplesPerRow = 5;
const maxItems = 50_000;
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
		for (const track of orderedTracks(scene.tracks)) {
			if (track.type === "audio" || disabled(track) || track.hidden) continue;
			const lane = track === scene.tracks.main && hostLane ? hostLane : JSON.stringify([...path, track.id]);
			for (const element of track.elements) {
				signal.throwIfAborted();
				if (++count > maxItems) { visit.truncated = true; return; }
				if (hidden(element)) continue;
				const interval = toRootInterval(element.startTime, element.startTime + element.duration, chain);
				if (!interval) continue;
				const address = { trackId: track.id, id: element.id, ...(path.length && { path }), ...(element.agentId && { agentId: element.agentId }) };
				yield { element, origin: shift + element.startTime, lane, clip: { from: interval[0], to: interval[1], address } };
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
	media: Canvas | undefined, thresholds: DraftThresholds): Motion[] {
	const { element, origin, clip } = item;
	const findings: Motion[] = [];
	const fit = media && Math.min(canvas.width / media.width, canvas.height / media.height);
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
			const speed = (a: ScalarAnimationKey, b: ScalarAnimationKey) => (b.value - a.value) * factor * ticksPerFrame / (b.time - a.time);
			const segment = (a: ScalarAnimationKey, b: ScalarAnimationKey) =>
				a.segmentToNext === "step" ? 0 : a.segmentToNext === "bezier" || b.time <= a.time ? undefined : speed(a, b);
			const extrapolation = "extrapolation" in channel ? channel.extrapolation : undefined;
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i], prev = keys[i - 1], next = keys[i + 1];
				const at = origin + key.time;
				if (at < start || at >= end || at <= clip.from || at >= clip.to) continue;
				if (prev && (prev.segmentToNext === "step" || key.time - prev.time <= ticksPerFrame + 1)) {
					let change = (key.value - prev.value) * factor;
					if (category === "rotation" && prev.segmentToNext === "step") change = ((((change + 180) % 360) + 360) % 360) - 180;
					if (Math.abs(change) >= thresholds[category]) {
						emit("keyframe-jump", at, change, [prev, key]);
						continue;
					}
				}
				const before = prev ? segment(prev, key) : extrapolation?.before === "linear" ? speed(key, next) : 0;
				const after = next ? segment(key, next) : extrapolation?.after === "linear" ? speed(prev, key) : 0;
				if (before !== undefined && after !== undefined) emit("speed-change", at, after - before,
					[prev, key, next].filter(Boolean), before, after);
			}
			// Only an authored linear segment crossing a real clip edge establishes a speed there.
			const edge = (at: number, entering: boolean) => {
				if (at < start || at > end || at === (entering ? end : start)) return;
				for (let i = 1; i < keys.length; i++) {
					const a = keys[i - 1], b = keys[i], time = at - origin;
					if (a.segmentToNext !== "linear" || !(entering ? a.time <= time && time < b.time : a.time < time && time <= b.time)) continue;
					const velocity = speed(a, b);
					emit(entering ? "motion-at-start" : "motion-at-end", at, entering ? velocity : -velocity, [a, b],
						entering ? 0 : velocity, entering ? velocity : 0);
					break;
				}
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
			for (const finding of motionFindings(item, start, end, TICKS_PER_SECOND / fps, canvas, size, thresholds)) motion.push(finding);
		}
	}
	return {
		sceneId: root.id, from: seconds(start), to: seconds(end), thresholds, incomplete: visit.truncated,
		sources: [...sources].map(([id, shots]) => sourceSummary(id, shots, end - start)).sort((a, b) => a.from - b.from),
		runs: [...lanes.values()].flatMap(sameSourceRuns).sort((a, b) => a.from - b.from),
		motion: motion.sort((a, b) => a.at - b.at),
	};
}

export type DraftReport = ReturnType<typeof inspectDraft>;

export function formatDraftReport(report: DraftReport, json: boolean) {
	const { sources, runs, motion, ...header } = report;
	const omitted = { sources: 0, runs: 0, motion: 0 };
	const sceneId = header.sceneId.length > 128 ? header.sceneId.slice(0, 128) + "…" : header.sceneId;
	const output = { ...header, sceneId, sources: [] as Source[], runs: [] as Run[], motion: [] as Motion[], omitted };
	const title = `Draft check ${header.from}–${header.to} s in ${JSON.stringify(sceneId)}${header.incomplete ? " (partial traversal)" : ""}`;
	const lines = [title];
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
	append("sources", sources, output.sources, 6_500);
	append("runs", runs, output.runs, 4_000);
	append("motion", motion, output.motion, 8_000);
	if (json) return output;
	lines.push(`Omitted rows: ${omitted.sources} sources, ${omitted.runs} runs, ${omitted.motion} motion.`);
	return lines.join("\n") + "\n";
}
