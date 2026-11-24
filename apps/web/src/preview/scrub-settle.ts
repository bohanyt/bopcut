const SETTLE_DELAY = 150;

export function createScrubSettle<Scene, Frames>({
	prepare, onResult, discard, now = () => performance.now(),
	after = (delay, run) => {
		const timer = setTimeout(run, delay);
		return () => clearTimeout(timer);
	},
}: {
	prepare: (scene: Scene, time: number) => Promise<Frames | null>;
	onResult: () => void;
	discard: (frames: Frames) => void;
	now?: () => number;
	after?: (delay: number, run: () => void) => () => void;
}) {
	type Target = { scene: Scene; time: number; due: number; attempted: boolean; prepared: boolean; frames?: Frames };
	let target: Target | undefined;
	let flight: Target | undefined;
	let scrubbing = false;
	let stopTimer: (() => void) | undefined;
	const matches = (scene: Scene, time: number) => target?.scene === scene && target.time === time;

	function clearTimer() {
		stopTimer?.();
		stopTimer = undefined;
	}

	function schedule() {
		if (!scrubbing || flight || stopTimer || !target || target.attempted) return;
		const requested = target;
		stopTimer = after(Math.max(0, requested.due - now()), () => {
			stopTimer = undefined;
			requested.attempted = true;
			flight = requested;
			void prepare(requested.scene, requested.time).catch(() => null).then(frames => {
				flight = undefined;
				if (target === requested) {
					if (frames !== null) {
						requested.frames = frames;
						requested.prepared = true;
					}
					onResult();
				} else if (frames !== null) discard(frames);
				schedule();
			});
		});
	}

	return {
		update(scene: Scene, time: number, dragging: boolean) {
			if (!matches(scene, time)) {
				clearTimer();
				if (target?.frames !== undefined) discard(target.frames);
				target = { scene, time, due: now() + SETTLE_DELAY, attempted: false, prepared: false };
			} else if (dragging && !scrubbing && target && !target.attempted) {
				target.due = now() + SETTLE_DELAY;
			}
			scrubbing = dragging;
			if (dragging) schedule();
			else clearTimer();
		},
		isPending: (scene: Scene, time: number) => matches(scene, time) && !!flight && flight === target,
		isPrepared: (scene: Scene, time: number) => matches(scene, time) && target?.prepared === true,
		take(scene: Scene, time: number) {
			if (!target || !matches(scene, time)) return;
			const frames = target.frames;
			target.frames = undefined;
			return frames;
		},
		reset() {
			clearTimer();
			if (target?.frames !== undefined) discard(target.frames);
			target = undefined;
			scrubbing = false;
		},
	};
}
