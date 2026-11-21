/** Coalesces paused changes and draws playback ticks without a second running frame loop. */
export function createPreviewFrameScheduler({
	render,
	requestFrame,
	cancelFrame,
}: {
	render: () => Promise<void> | void;
	requestFrame: (callback: () => void) => number;
	cancelFrame: (id: number) => void;
}) {
	let frame: number | null = null;
	let rendering = false;
	let dirty = false;
	let disposed = false;

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
		const finish = () => {
			rendering = false;
			if (dirty) request();
		};
		void task.then(finish, finish);
	}

	function request(): void {
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
		request,
		playbackTick: () => {
			clearFrame();
			draw();
		},
		dispose: () => {
			disposed = true;
			clearFrame();
		},
	};
}
