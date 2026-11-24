export function createSelectionWriter({
	isScrubbing,
	readBody,
	send,
}: {
	isScrubbing: () => boolean;
	readBody: () => string;
	send: (body: string) => Promise<void>;
}) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = false;
	let sending = false;
	let lastBody: string | undefined;

	const flush = async () => {
		if (!pending || sending || isScrubbing()) return;
		pending = false;
		const body = readBody();
		if (body === lastBody) return;
		sending = true;
		try {
			await send(body);
			lastBody = body;
		} catch {
			lastBody = undefined;
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
			timer = setTimeout(() => {
				pending = true;
				void flush();
			}, 250);
		},
	};
}
