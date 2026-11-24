/** In the browser, hold the activity open until export or microphone capture stops. */
export function editorActivity(): Promise<(() => void) | null> | undefined {
	if (typeof location === "undefined" || typeof window === "undefined") return;
	const controller = new AbortController();
	const release = () => controller.abort();
	const deadline = setTimeout(release, 3000);
	return fetch("/api/agent/cli/activity", { method: "POST", signal: controller.signal })
		.then(async (response) => {
			if (!response.ok || !response.body) { release(); return null; }
			const reader = response.body.getReader();
			const result = await reader.read();
			if (result.done) { release(); return null; }
			return () => { void reader.cancel().catch(() => {}); release(); };
		})
		.catch(() => null).finally(() => clearTimeout(deadline));
}
