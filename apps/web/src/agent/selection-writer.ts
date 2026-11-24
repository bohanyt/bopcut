export function createSelectionWriter({
	isScrubbing,
	readBody,
	send,
}: {
	isScrubbing: () => boolean;
	readBody: () => string;
	send: (body: string, keepalive: boolean) => Promise<void>;
}) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastBody = "";
	let revision = 0;
	const flush = (keepalive: boolean) => {
		if (timer === undefined || isScrubbing()) return;
		clearTimeout(timer);
		timer = undefined;
		const body = readBody();
		if (body === lastBody) return;
		lastBody = body;
		const attempt = ++revision;
		void send(body, keepalive).catch(() => {
			if (attempt === revision) lastBody = "";
		});
	};

	return {
		schedule: () => {
			if (isScrubbing()) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (isScrubbing()) timer = undefined;
				else flush(false);
			}, 250);
		},
		flushOnHide: () => flush(true),
	};
}
