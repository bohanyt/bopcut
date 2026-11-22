export const JOB_HEADER = "x-bopencut-job";

let hiddenJob: string | undefined;

export function setHiddenStorageJob(id: string) { hiddenJob = id; }
export function hasHiddenStorageJob() { return hiddenJob !== undefined; }

export function diskFetch(input: string, init?: RequestInit): Promise<Response> {
	if (!hiddenJob) return fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set(JOB_HEADER, hiddenJob);
	return fetch(input, { ...init, headers });
}

export type AgentFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type JobTransport = {
	request: AgentFetch;
	signal: AbortSignal;
	progress(stage: string): Promise<void>;
	publishSnapshot?(): Promise<void>;
};
