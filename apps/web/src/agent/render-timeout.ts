import { renderGpuWorkaround } from "./render-gpu";

export const waitingForRender = "waiting for a tab";
export const waitingForGraphics = "waiting for graphics";

export function renderTimeoutMessage(timeoutMs: number, stage: string) {
	const advice = stage === waitingForRender
		? "Open the editor and retry, or increase --timeout."
		: "Increase --timeout and retry.";
	return `Timed out after ${timeoutMs / 1000} s without progress while ${stage}. ${advice}` +
		(stage === waitingForGraphics ? ` ${renderGpuWorkaround}` : "");
}
