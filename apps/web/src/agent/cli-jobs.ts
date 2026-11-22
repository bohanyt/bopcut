import { randomUUID } from "node:crypto";

export const jobCommands = ["draft", "frames", "changes", "export"] as const;
export type JobCommand = typeof jobCommands[number];
export type JobBody = Record<string, unknown>;
export type JobUpdate = { version: number; stage: string; percent?: number; done?: boolean; result?: JobBody };
export { JOB_HEADER } from "./cli-transport";

export class AgentJob {
	readonly id = randomUUID();
	readonly controller = new AbortController();
	readonly released = Promise.withResolvers<void>();
	readonly pending = new Set<Promise<unknown>>();
	readonly staged = new Set<string>();
	readonly frameFiles = new Set<string>();
	readonly words = new Map<string, JobBody>();
	readonly expires: ReturnType<typeof setTimeout>;
	owner: string | null = null;
	committed = false;
	ending: Promise<void> | undefined;
	resultFile: string | undefined;
	update: JobUpdate = { version: 0, stage: "waiting for a tab" };
	private changed = Promise.withResolvers<void>();

	constructor(
		readonly projectId: string,
		readonly command: JobCommand,
		readonly body: JobBody,
		readonly hidden: boolean,
		timeoutMs: number,
		onExpire: () => void,
	) {
		this.expires = setTimeout(onExpire, timeoutMs + 15000);
		this.expires.unref();
	}

	get signal() { return this.controller.signal; }

	claim(owner: string) {
		if (this.signal.aborted || this.owner) return false;
		this.owner = owner;
		this.progress("loading the project");
		return true;
	}

	use<T>(action: () => Promise<T>): Promise<T> {
		this.signal.throwIfAborted();
		const task = Promise.resolve().then(action);
		this.pending.add(task);
		const clear = () => this.pending.delete(task);
		void task.then(clear, clear);
		return task;
	}

	progress(stage: string, percent?: number, done = false) {
		if (this.update.done || this.signal.aborted) return;
		if (!done && stage === this.update.stage && percent === this.update.percent) return;
		this.update = { version: this.update.version + 1, stage, percent, done };
		this.changed.resolve();
		this.changed = Promise.withResolvers<void>();
	}

	async wait(version: number, signal: AbortSignal): Promise<JobUpdate> {
		if (!this.update.done && this.update.version === version) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const abort = () => resolve();
			signal.addEventListener("abort", abort, { once: true });
			this.signal.addEventListener("abort", abort, { once: true });
			try {
				if (!signal.aborted && !this.signal.aborted) await Promise.race([promise, this.changed.promise]);
			} finally {
				signal.removeEventListener("abort", abort);
				this.signal.removeEventListener("abort", abort);
			}
		}
		return this.update;
	}
}

export class AgentJobs {
	active: AgentJob | null = null;
	private readonly tabs = new Map<string, Map<string, object>>();

	constructor(private readonly cleanup: (job: AgentJob) => Promise<void> = async () => {}) {}

	register(projectId: string, tab: string): () => void {
		const tabs = this.tabs.get(projectId) ?? new Map();
		this.tabs.set(projectId, tabs);
		const identity = {};
		tabs.set(tab, identity);
		return () => {
			if (tabs.get(tab) !== identity) return;
			tabs.delete(tab);
			if (!tabs.size) this.tabs.delete(projectId);
		};
	}

	serving(projectId: string, tab?: string) {
		return tab ? this.tabs.get(projectId)?.has(tab) === true : this.tabs.has(projectId);
	}

	async beforeOpen(projectId: string): Promise<void> {
		const job = this.active;
		if (job?.hidden && job.command === "draft" && job.projectId === projectId) await job.released.promise;
	}

	create(projectId: string, command: JobCommand, body: JobBody, timeoutMs: number): AgentJob {
		if (this.active) throw new Error("An agent command is already running. Wait for it to finish and try again.");
		const job = new AgentJob(projectId, command, body, !this.serving(projectId), timeoutMs, () => {
			void this.close(job).catch((error) => console.error("Agent cleanup failed:", error));
		});
		this.active = job;
		return job;
	}

	close(job: AgentJob, reason = "The job ended"): Promise<void> {
		if (job.ending) return job.ending;
		job.controller.abort(new Error(reason));
		clearTimeout(job.expires);
		job.ending = (async () => {
			try {
				await Promise.allSettled(job.pending);
				await this.cleanup(job);
			} finally {
				if (this.active === job) this.active = null;
				job.released.resolve();
			}
		})();
		return job.ending;
	}
}
