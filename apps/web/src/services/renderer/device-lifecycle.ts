type DeviceStatus =
	| { state: "idle" | "starting" | "ready" | "recovering" }
	| { state: "unavailable"; detail: string };

type DeviceOptions = {
	initialize: (onLost: () => void) => Promise<void>;
	scheduleRecovery: (recover: () => void) => void;
};

export type GraphicsIssueKind =
	| "graphicsUnavailable"
	| "graphicsNotReady"
	| "graphicsLost"
	| "graphicsModel"
	| "graphicsSurface";

export class GraphicsDeviceError extends Error {
	constructor(
		public readonly kind: GraphicsIssueKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export class DeviceLifecycle {
	private current: DeviceStatus = { state: "idle" };
	private pending: Promise<void> | null = null;
	private generation = new AbortController();
	private autoRecover = true;
	private listeners = new Set<() => void>();

	constructor(private options: DeviceOptions) {}

	get status(): DeviceStatus {
		return this.current;
	}

	get signal(): AbortSignal {
		return this.generation.signal;
	}

	getSnapshot = () => this.current;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	start(): Promise<void> {
		if (this.current.state === "idle") return this.initialize("starting");
		return this.pending ?? Promise.resolve();
	}

	retry(): Promise<void> {
		if (this.current.state === "unavailable") {
			this.autoRecover = true;
			return this.initialize("starting");
		}
		return this.start();
	}

	requireReady(): AbortSignal {
		const status = this.current;
		if (status.state === "unavailable") {
			throw new GraphicsDeviceError("graphicsUnavailable", `Preview and export are unavailable. Retry graphics initialization. ${status.detail}`);
		}
		if (status.state !== "ready") {
			throw new GraphicsDeviceError("graphicsNotReady", "Graphics device is starting or recovering. Try again when it is ready.");
		}
		return this.signal;
	}

	markFramePresented(): void {
		this.autoRecover = true;
	}

	private initialize(state: "starting" | "recovering"): Promise<void> {
		const attempt = new AbortController();
		this.generation = attempt;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.pending = promise;
		if (this.current.state !== state) this.publish({ state });
		void this.runAttempt(attempt).finally(() => {
			if (this.pending === promise) this.pending = null;
			resolve();
		});
		return promise;
	}

	private async runAttempt(attempt: AbortController): Promise<void> {
		try {
			await this.options.initialize(() => this.deviceLost(attempt));
			attempt.signal.throwIfAborted();
			this.publish({ state: "ready" });
		} catch (error) {
			this.publish({ state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
		}
	}

	private deviceLost(attempt: AbortController): void {
		if (this.generation !== attempt || attempt.signal.aborted) return;
		const error = new GraphicsDeviceError("graphicsLost", "Graphics device was lost. Try again after graphics recovery.");
		attempt.abort(error);
		if (this.current.state !== "ready") return;
		if (!this.autoRecover) {
			this.publish({ state: "unavailable", detail: error.message });
			return;
		}
		this.autoRecover = false;
		this.publish({ state: "recovering" });
		this.options.scheduleRecovery(() => void this.initialize("recovering"));
	}

	private publish(status: DeviceStatus): void {
		this.current = status;
		for (const listener of this.listeners) listener();
	}
}
