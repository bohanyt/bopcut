/** Stop awaiting work whose underlying API may not support cancellation. */
export function waitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;

	const stopped = Promise.withResolvers<never>();
	const abort = () => stopped.reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	return Promise.race([stopped.promise, work]).finally(() => {
		signal.removeEventListener("abort", abort);
	});
}
