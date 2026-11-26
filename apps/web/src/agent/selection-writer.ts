export function createSelectionWriter({
	isScrubbing,
	readBody,
	send,
}: {
	isScrubbing: () => boolean;
	readBody: () => string;
	/** Return false for a permanent rejection. Throw when the write can be retried. */
	send: (body: string) => Promise<void | false>;
}) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = false;
	let sending = false;
	let lastBody: string | undefined;
	let failedBody: string | undefined;
	let retryDelay = 500;

	const arm = (delay: number) => {
		timer = setTimeout(() => {
			timer = undefined;
			pending = true;
			void flush();
		}, delay);
	};

	const flush = async () => {
		if (!pending || sending || isScrubbing()) return;
		pending = false;
		const body = readBody();
		if (body === lastBody) return;
		if (body !== failedBody) retryDelay = 500;
		sending = true;
		try {
			if (await send(body) !== false) lastBody = body;
			failedBody = undefined;
		} catch {
			lastBody = undefined;
			failedBody = body;
			if (!pending && timer === undefined) arm(retryDelay);
			retryDelay = Math.min(10_000, retryDelay * 2);
		} finally {
			sending = false;
			void flush();
		}
	};

	return {
		schedule: () => {
			if (isScrubbing()) return;
			clearTimeout(timer);
			pending = false;
			arm(250);
		},
	};
}
