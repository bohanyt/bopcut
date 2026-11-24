/** Coalesces paused changes and draws playback ticks without a second running frame loop. */
export function createPreviewFrameScheduler({
	render,
	requestFrame,
	cancelFrame,
	shouldRetry,
	now = () => performance.now(),
	setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
	clearTimer = (id) => globalThis.clearTimeout(id),
}: {
	render: (options: { signal: AbortSignal; approximate: boolean }) => Promise<void> | void;
	requestFrame: (callback: () => void) => number;
	cancelFrame: (id: number) => void;
	shouldRetry?: (error: unknown) => boolean;
	now?: () => number;
	setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}) {
	const settleDelay = 64;
	let frame: number | null = null;
	let rendering: AbortController | null = null;
	let dirty = false;
	let disposed = false;
	let retried = false;
	let approximate = false;
	let lastSeek = -Infinity;
	let lastSeekTime: number | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	function draw(): void {
		if (disposed) return;
		if (rendering) {
			dirty = true;
			return;
		}
		dirty = false;
		const controller = new AbortController();
		const task = render({ signal: controller.signal, approximate });
		if (!task) return;
		rendering = controller;
		const finish = (retry = false) => {
			rendering = null;
			if (dirty) {
				queueFrame();
			} else if (retry && !retried) {
				retried = true;
				queueFrame();
			}
		};
		void task.then(() => finish(), (error) => finish(shouldRetry?.(error)));
	}

	function queueFrame(): void {
		if (disposed || frame !== null) return;
		if (rendering) {
			dirty = true;
			return;
		}
		frame = requestFrame(() => {
			frame = null;
			draw();
		});
	}

	function clearFrame(): void {
		if (frame === null) return;
		cancelFrame(frame);
		frame = null;
	}

	function invalidate(): void {
		retried = false;
		queueFrame();
		rendering?.abort();
	}

	function clearSettle(): void {
		if (settleTimer !== undefined) clearTimer(settleTimer);
		settleTimer = undefined;
	}

	function settle(): void {
		clearSettle();
		lastSeek = -Infinity;
		lastSeekTime = undefined;
		if (!approximate) return;
		approximate = false;
		invalidate();
	}

	return {
		request: () => {
			retried = false;
			queueFrame();
		},
		playbackTick: () => {
			retried = false;
			clearFrame();
			draw();
		},
		seek: (playheadTime: number, scrubbing: boolean, playing: boolean) => {
			const time = now();
			const nextMode = scrubbing || (!playing && time - lastSeek < settleDelay);
			const changed = playheadTime !== lastSeekTime || nextMode !== approximate;
			approximate = nextMode;
			lastSeek = playing ? -Infinity : time;
			lastSeekTime = playheadTime;
			clearSettle();
			if (approximate) settleTimer = setTimer(settle, settleDelay);
			if (changed) invalidate();
		},
		settle,
		scrubFrameReady: () => {
			if (approximate) queueFrame();
		},
		invalidate,
		suspend: () => {
			clearSettle();
			clearFrame();
			approximate = false;
			lastSeek = -Infinity;
			lastSeekTime = undefined;
			dirty = false;
			rendering?.abort();
		},
		dispose: () => {
			disposed = true;
			clearFrame();
			clearSettle();
			rendering?.abort();
		},
	};
}
