interface ClipInterval {
	id: string;
	startTime: number;
	duration: number;
}

interface Entry<T> {
	clip: T;
	order: number;
}

interface Branch<T> {
	entry: Entry<T>;
	maxEnd: number;
	left: Branch<T> | null;
	right: Branch<T> | null;
}

function buildTree<T extends ClipInterval>(
	entries: Entry<T>[],
	start: number,
	end: number,
): Branch<T> | null {
	if (start === end) return null;
	const middle = Math.floor((start + end) / 2);
	const entry = entries[middle];
	const left = buildTree(entries, start, middle);
	const right = buildTree(entries, middle + 1, end);
	return {
		entry,
		left,
		right,
		maxEnd: Math.max(
			entry.clip.startTime + entry.clip.duration,
			left?.maxEnd ?? -Infinity,
			right?.maxEnd ?? -Infinity,
		),
	};
}

export function buildClipIndex<T extends ClipInterval>(clips: readonly T[]) {
	const entries = clips.map((clip, order) => ({ clip, order }));
	const byId = new Map(entries.map((entry) => [entry.clip.id, entry]));
	entries.sort((a, b) => a.clip.startTime - b.clip.startTime);
	const root = buildTree(entries, 0, entries.length);

	return {
		get(id: string) {
			return byId.get(id)?.clip;
		},
		query(start: number, end: number, pinned?: Iterable<string>): T[] {
			const matches = new Set<Entry<T>>();
			const visit = (branch: Branch<T> | null) => {
				if (!branch || branch.maxEnd < start) return;
				const { entry, left, right } = branch;
				visit(left);
				if (entry.clip.startTime > end) return;
				if (entry.clip.startTime + entry.clip.duration >= start) {
					matches.add(entry);
				}
				visit(right);
			};
			visit(root);
			for (const id of pinned ?? []) {
				const entry = byId.get(id);
				if (entry) matches.add(entry);
			}
			// Preserve DOM stacking and hit priority for overlapping elements.
			return [...matches]
				.sort((a, b) => a.order - b.order)
				.map(({ clip }) => clip);
		},
	};
}
