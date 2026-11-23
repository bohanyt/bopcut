export const waitingForRender = "waiting for a tab";

/** How often an upload reports its stage: often enough that a working upload never looks stalled. */
export const uploadReportInterval = (timeoutMs: number) => Math.min(2000, timeoutMs / 4);

export function renderTimeoutMessage(timeoutMs: number, stage: string) {
	const advice = stage === waitingForRender
		? "Open the editor and retry, or increase --timeout."
		: "Increase --timeout and retry.";
	return `Timed out after ${timeoutMs / 1000} s without progress while ${stage}. ${advice}`;
}
