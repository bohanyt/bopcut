/** Coalesces paused changes and draws playback ticks without a second running frame loop. */
export function createPreviewFrameScheduler({
	render,
	requestFrame,
	cancelFrame,
	shouldRetry,
	setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
	clearTimer = (id) => globalThis.clearTimeout(id),
}: {
	render: (options: { signal: AbortSignal; approximate: boolean }) => Promise<void> | void;
	requestFrame: (callback: () => void) => number;
	cancelFrame: (id: number) => void;
	shouldRetry?: (error: unknown) => boolean;
	setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}) {
	const settleDelay = 64;
	const holdDelay = 250;
	let frame: number | null = null;
	let rendering: AbortController | null = null;
	let dirty = false;
	let disposed = false;
	let retried = false;
	let approximate = false;
	let lastSeekTime: number | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let recovering = false;

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

	function clearHold(): void {
		if (holdTimer !== undefined) clearTimer(holdTimer);
		holdTimer = undefined;
	}

	function settle(): void {
		clearSettle();
		clearHold();
		lastSeekTime = undefined;
		if (!approximate && !recovering) return;
		approximate = false;
		recovering = false;
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
			const explicit = scrubbing && !playing;
			if (!explicit) {
				clearHold();
				recovering = false;
			}
			const nextMode = explicit && !recovering;
			const changed = playheadTime !== lastSeekTime || nextMode !== approximate;
			approximate = nextMode;
			lastSeekTime = playheadTime;
			clearSettle();
			if (approximate) settleTimer = setTimer(settle, settleDelay);
			if (changed) {
				if (recovering) queueFrame();
				else invalidate();
			}
		},
		settle,
		scrubFrameBlocked: () => {
			if (!approximate || holdTimer !== undefined) return;
			holdTimer = setTimer(() => {
				holdTimer = undefined;
				clearSettle();
				approximate = false;
				recovering = true;
				invalidate();
			}, holdDelay);
		},
		scrubFramePresented: () => { clearHold(); },
		scrubRecoveryFinished: () => { recovering = false; },
		scrubFrameReady: () => {
			if (approximate) queueFrame();
		},
		invalidate,
		suspend: () => {
			clearSettle();
			clearHold();
			clearFrame();
			approximate = false;
			recovering = false;
			lastSeekTime = undefined;
			dirty = false;
			rendering?.abort();
		},
		dispose: () => {
			disposed = true;
			clearFrame();
			clearSettle();
			clearHold();
			rendering?.abort();
		},
	};
}
