const SETTLE_DELAY = 150;
const RELEASE_DEADLINE = 1000;

export function createScrubSettle<Scene, Frames>({
	prepare, onResult, discard, now = () => performance.now(),
	after = (delay, run) => {
		const timer = setTimeout(run, delay);
		return () => clearTimeout(timer);
	},
}: {
	prepare: (scene: Scene, time: number, signal: AbortSignal) => Promise<Frames | null>;
	onResult: () => void;
	discard: (frames: Frames) => void;
	now?: () => number;
	after?: (delay: number, run: () => void) => () => void;
}) {
	type Target = { scene: Scene; time: number; due: number; attempted: boolean; prepared: boolean; frames?: Frames; decode?: AbortController };
	let target: Target | undefined;
	let scrubbing = false;
	let stopTimer: (() => void) | undefined;
	const matches = (scene: Scene, time: number) => target?.scene === scene && target.time === time;

	function clearTimer() {
		stopTimer?.();
		stopTimer = undefined;
	}

	function abortDecode(requested: Target) {
		const decode = requested.decode;
		requested.decode = undefined;
		decode?.abort();
	}

	function clearTarget() {
		clearTimer();
		if (!target) return;
		abortDecode(target);
		if (target.frames !== undefined) discard(target.frames);
		target = undefined;
	}

	function schedule() {
		if (!scrubbing || stopTimer || !target || target.attempted) return;
		const requested = target;
		stopTimer = after(Math.max(0, requested.due - now()), () => {
			stopTimer = undefined;
			requested.attempted = true;
			const decode = new AbortController();
			requested.decode = decode;
			void prepare(requested.scene, requested.time, decode.signal).catch(() => null).then(frames => {
				if (target === requested && requested.decode === decode) {
					requested.decode = undefined;
					clearTimer();
					if (frames !== null) {
						requested.frames = frames;
						requested.prepared = true;
					}
					onResult();
				} else if (frames !== null) discard(frames);
			});
		});
	}

	return {
		update(scene: Scene, time: number, dragging: boolean) {
			if (!matches(scene, time)) {
				clearTarget();
				target = { scene, time, due: now() + SETTLE_DELAY, attempted: false, prepared: false };
			} else if (dragging && !scrubbing && target) {
				clearTimer();
				if (!target.decode && !target.prepared) {
					target.attempted = false;
					target.due = now() + SETTLE_DELAY;
				}
			}
			if (!dragging && scrubbing) {
				clearTimer();
				const released = target;
				if (released?.decode) stopTimer = after(RELEASE_DEADLINE, () => {
					stopTimer = undefined;
					abortDecode(released);
					onResult();
				});
			}
			scrubbing = dragging;
			if (dragging) schedule();
		},
		isPending: (scene: Scene, time: number) => matches(scene, time) && !!target?.decode,
		isPrepared: (scene: Scene, time: number) => matches(scene, time) && target?.prepared === true,
		take(scene: Scene, time: number) {
			if (!target || !matches(scene, time)) return;
			const frames = target.frames;
			target.frames = undefined;
			return frames;
		},
		reset() {
			clearTarget();
			scrubbing = false;
		},
	};
}
