let reviewRunning = false;
let editorActivities = 0;

export const isReviewRunning = () => reviewRunning;

export function reserveReview(renderBusy: boolean): (() => void) | null {
	if (reviewRunning || editorActivities || renderBusy) return null;
	reviewRunning = true;
	return () => { reviewRunning = false; };
}

export function reserveEditorActivity(signal: AbortSignal): Response {
	if (reviewRunning) return Response.json({ error: "An export review is running." }, { status: 409 });
	editorActivities++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		editorActivities--;
		signal.removeEventListener("abort", release);
	};
	signal.addEventListener("abort", release, { once: true });
	if (signal.aborted) release();
	const body = new ReadableStream({
		start(stream) {
			stream.enqueue(new Uint8Array([10]));
			signal.addEventListener("abort", () => {
				try { stream.close(); } catch { /* The client already disconnected. */ }
			}, { once: true });
		},
		cancel: release,
	});
	return new Response(body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
}
