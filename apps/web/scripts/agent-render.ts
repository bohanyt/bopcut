import { launchBrowser, type RunningBrowser } from "./agent-browser";
import { renderTimeoutMessage, waitingForRender } from "../src/agent/render-timeout";

export async function runRender(response: Response, { timeoutMs, signal: interrupt, launch = launchBrowser, progress = console.error }: {
	timeoutMs: number;
	signal: AbortSignal;
	launch?: typeof launchBrowser;
	progress?: (stage: string) => void;
}): Promise<Record<string, unknown>> {
	let stage: string | undefined;
	let browser: RunningBrowser | undefined;
	let exited = false;
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	const stall = new AbortController();
	const signal = AbortSignal.any([interrupt, stall.signal]);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const resetDeadline = () => {
		clearTimeout(deadline);
		deadline = setTimeout(() => stall.abort(new Error(renderTimeoutMessage(timeoutMs, stage ?? waitingForRender))), timeoutMs);
	};
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	resetDeadline();
	try {
		let pending = "";
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read().catch((cause) => {
				throw new Error(`Lost the editor server connection while ${stage ?? waitingForRender}.`, { cause });
			});
			signal.throwIfAborted();
			if (exited) throw new Error("The hidden browser exited. Open the project in the editor and retry.");
			if (done) throw new Error(`The editor server stopped while ${stage ?? waitingForRender}.`);
			pending += value;
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines) {
				const event = JSON.parse(line);
				const nextStage: unknown = event.stage;
				if (typeof nextStage === "string" && nextStage && nextStage !== stage) {
					stage = nextStage;
					resetDeadline();
					progress(stage);
				}
				if (event.launch && !browser) {
					browser = launch(event.launch, event.profile);
					void browser.exited.then(() => { exited = true; abort(); });
				}
				if (event.result) return event.result;
			}
		}
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw error;
	} finally {
		clearTimeout(deadline);
		signal.removeEventListener("abort", abort);
		await Promise.all([reader.cancel().catch(() => {}), browser?.stop()]);
	}
}
