import { launchBrowser, type RunningBrowser } from "./agent-browser";

export async function runRender(response: Response, { signal, launch = launchBrowser, progress = console.error }: {
	signal: AbortSignal;
	launch?: typeof launchBrowser;
	progress?: (stage: string) => void;
}): Promise<Record<string, unknown>> {
	let stage = "waiting for a tab";
	let browser: RunningBrowser | undefined;
	let exited = false;
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		let pending = "";
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read().catch((cause) => {
				throw new Error(`Lost the editor server connection while ${stage}.`, { cause });
			});
			signal.throwIfAborted();
			if (exited) throw new Error("The hidden browser exited. Open the project in the editor and retry.");
			if (done) throw new Error(`The editor server stopped while ${stage}.`);
			pending += value;
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines) {
				const event = JSON.parse(line);
				if (event.stage) progress(stage = event.stage);
				if (event.launch && !browser) {
					browser = launch(event.launch, event.profile);
					void browser.exited.then(() => { exited = true; abort(); });
				}
				if (event.result) return event.result;
			}
		}
	} catch (error) {
		if (signal.reason?.name === "TimeoutError") throw new Error(`Timed out while ${stage}.`);
		if (signal.aborted) throw signal.reason;
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		await browser?.stop();
	}
}
