type Job = (signal: AbortSignal) => Promise<void>;

export class ThumbnailQueue<Key extends object> {
	private readonly pending = new Map<Key, { users: number; decode: Job }>();
	private finished = new WeakSet<Key>();
	private running?: { key: Key; controller: AbortController };
	private cancelIdle?: () => void;
	private unwatch?: () => void;

	constructor(private readonly options: {
		busy: () => boolean;
		watch: (check: () => void) => () => void;
		idle: (run: () => void) => () => void;
	}) {}

	request(key: Key, decode: Job): () => void {
		if (this.finished.has(key)) return () => {};
		const entry = this.pending.get(key) ?? { users: 0, decode };
		entry.users++;
		this.pending.delete(key);
		this.pending.set(key, entry);
		this.check();
		return () => {
			if (--entry.users || this.pending.get(key) !== entry) return;
			this.pending.delete(key);
			if (this.running?.key === key) this.running.controller.abort();
			this.check();
		};
	}

	clear(): void {
		this.pending.clear();
		this.finished = new WeakSet<Key>();
		this.running?.controller.abort();
		this.check();
	}

	private check = (): void => {
		if (!this.pending.size) {
			this.cancelIdle?.();
			this.cancelIdle = undefined;
			this.unwatch?.();
			this.unwatch = undefined;
			return;
		}
		this.unwatch ??= this.options.watch(this.check);
		if (this.options.busy()) {
			this.cancelIdle?.();
			this.cancelIdle = undefined;
			this.running?.controller.abort();
		} else if (!this.running && !this.cancelIdle) {
			this.cancelIdle = this.options.idle(() => {
				this.cancelIdle = undefined;
				if (this.options.busy()) return;
				const next = Array.from(this.pending).at(-1);
				if (next) void this.run(...next);
			});
		}
	};

	private async run(key: Key, entry: { decode: Job }): Promise<void> {
		const controller = new AbortController();
		this.running = { key, controller };
		try {
			await entry.decode(controller.signal);
		} catch {
			// Leave unreadable media on its placeholder for this session.
		} finally {
			if (!controller.signal.aborted) {
				this.finished.add(key);
				if (this.pending.get(key) === entry) this.pending.delete(key);
			}
			this.running = undefined;
			this.check();
		}
	}
}
