/** Coalesces paused changes and draws playback ticks without a second running frame loop. */
export function createPreviewFrameScheduler({
	render,
	requestFrame,
	cancelFrame,
	shouldRetry,
}: {
	render: () => Promise<void> | void;
	requestFrame: (callback: () => void) => number;
	cancelFrame: (id: number) => void;
	shouldRetry?: (error: unknown) => boolean;
}) {
	let frame: number | null = null;
	let rendering = false;
	let dirty = false;
	let disposed = false;
	let retried = false;

	function draw(): void {
		if (disposed) return;
		if (rendering) {
			dirty = true;
			return;
		}
		dirty = false;
		const task = render();
		if (!task) return;
		rendering = true;
		const finish = (retry = false) => {
			rendering = false;
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
		dispose: () => {
			disposed = true;
			clearFrame();
		},
	};
}
