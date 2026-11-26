import { launchBrowser, type BrowserExit, type RunningBrowser } from "./agent-browser";
import { renderGpuWorkaround } from "../src/agent/render-gpu";
import { renderTimeoutMessage, waitingForRender } from "../src/agent/render-timeout";

/** A browser that ends this fast on its own did not run the page: something took its launch over. */
const QUICK_EXIT_MS = 5000;

export function hiddenBrowserExitMessage(exit: BrowserExit | void): string {
	if (exit?.error) return `The hidden browser could not start (${exit.error}). Set BOPENCUT_BROWSER to an installed Chrome or Edge, or open the project in the editor and retry.`;
	const how = exit
		? ` (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`} after ${(exit.afterMs / 1000).toFixed(1)} s)`
		: "";
	if (exit && !exit.signal && exit.code === 0 && exit.afterMs < QUICK_EXIT_MS) {
		return `The hidden browser exited${how} on its own, which it does not do while it renders. Often another process of that browser took the launch over: one already running on the same profile, or one a browser policy makes take it (HeadlessModeEnabled turned off, or UserDataDir forced; see edge://policy or chrome://policy). Close other hidden browsers, set BOPENCUT_BROWSER to another Chrome or Edge, or open the project in the editor and retry.`;
	}
	return `The hidden browser exited${how}. Open the project in the editor and retry. ${renderGpuWorkaround}`;
}

export async function runRender(response: Response, { timeoutMs, signal: interrupt, launch = launchBrowser, progress = console.error }: {
	timeoutMs: number;
	signal: AbortSignal;
	launch?: typeof launchBrowser;
	progress?: (stage: string) => void;
}): Promise<Record<string, unknown>> {
	let stage: string | undefined;
	let browser: RunningBrowser | undefined;
	let exited = false;
	let exit: BrowserExit | void = undefined;
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
			if (exited) throw new Error(hiddenBrowserExitMessage(exit));
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
					void browser.exited.then((outcome) => { exit = outcome; exited = true; abort(); });
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
