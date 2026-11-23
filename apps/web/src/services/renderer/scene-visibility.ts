import type { AnyBaseNode } from "./nodes/base-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { TextNode } from "./nodes/text-node";
import { VisualNode } from "./nodes/visual-node";

export type SceneChild = { node: AnyBaseNode; index: number };

type Interval = SceneChild & { start: number; end: number; maxEnd: number };

export const EFFECT_TIME_EPSILON = 1e-6;

function getTimeRange(node: AnyBaseNode) {
	if (node instanceof EffectLayerNode) {
		return {
			start: node.params.timeOffset - EFFECT_TIME_EPSILON,
			end: node.params.timeOffset + node.params.duration + EFFECT_TIME_EPSILON,
		};
	}
	if (node instanceof TextNode) {
		return { start: node.params.startTime, end: node.params.startTime + node.params.duration };
	}
	if (node instanceof VisualNode || node instanceof BlurBackgroundNode) {
		return { start: node.params.timeOffset, end: node.params.timeOffset + node.params.duration };
	}
	return null;
}

// Each range is rooted at its middle entry, with the latest end in that entire subtree.
function indexEnds(intervals: Interval[], first: number, limit: number): number {
	if (first === limit) return -Infinity;
	const middle = (first + limit) >>> 1;
	const interval = intervals[middle];
	interval.maxEnd = Math.max(
		interval.end,
		indexEnds(intervals, first, middle),
		indexEnds(intervals, middle + 1, limit),
	);
	return interval.maxEnd;
}

function collectAt(
	intervals: Interval[],
	first: number,
	limit: number,
	time: number,
	children: SceneChild[],
): void {
	if (first === limit || time < intervals[first].start) return;
	const middle = (first + limit) >>> 1;
	const interval = intervals[middle];
	if (time >= interval.maxEnd) return;
	collectAt(intervals, first, middle, time, children);
	if (time < interval.start) return;
	if (time < interval.end) children.push(interval);
	collectAt(intervals, middle + 1, limit, time, children);
}

export class SceneVisibility {
	private readonly intervals: Interval[] = [];
	private readonly unindexed: SceneChild[] = [];

	constructor(private readonly children: readonly AnyBaseNode[]) {
		children.forEach((node, index) => {
			const range = getTimeRange(node);
			if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
				this.intervals.push({ node, index, ...range, maxEnd: range.end });
			} else {
				this.unindexed.push({ node, index });
			}
		});
		this.intervals.sort((a, b) => a.start - b.start);
		indexEnds(this.intervals, 0, this.intervals.length);
	}

	at(time: number): readonly SceneChild[] {
		if (!Number.isFinite(time)) return this.children.map((node, index) => ({ node, index }));
		const children = [...this.unindexed];
		collectAt(this.intervals, 0, this.intervals.length, time, children);
		if (children.length === this.unindexed.length) return this.unindexed;
		// The original index defines stacking order and remains part of the texture ID.
		return children.sort((a, b) => a.index - b.index);
	}
}
