export type ProxyInfo = {
	key: string;
	width: number;
	height: number;
	source: number[];
	proxy: number[];
};

export type ProxyUpdate = {
	state: "preparing" | "ready" | "empty" | "missing" | "failed" | "disk" | "off" | "software" | "readonly";
	/** Why tools failed, for `failed`. */
	error?: string;
	done: number;
	total: number;
	bytes: number;
	media?: { id: string; info: ProxyInfo };
	evicted?: string;
};

export function proxyTime(info: ProxyInfo, time: number): number | undefined {
	if (!info.source.length || info.source.length !== info.proxy.length) return;
	let first = 0;
	let last = info.source.length;
	while (first < last) {
		const mid = (first + last) >>> 1;
		if (info.source[mid] <= time) first = mid + 1;
		else last = mid;
	}
	const index = Math.max(0, first - 1);
	const start = info.proxy[index];
	const end = info.proxy[index + 1];
	// Seek inside the presentation interval so container tick rounding cannot choose its neighbor.
	return end === undefined ? start + 0.000001 : start + (end - start) / 2;
}
