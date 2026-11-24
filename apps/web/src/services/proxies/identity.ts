export const proxyProfile = "p1-v4";
export const cachedProxyKey = /^[a-f0-9]{64}-p1-v[1-4]$/;

export function proxyFingerprintRegions(size: number) {
	const block = 64 * 1024;
	const endBlock = Math.min(size, 1024 * 1024);
	const lastStart = Math.max(0, size - block);
	const starts = Array.from({ length: 32 }, (_, index) => Math.floor(lastStart * index / 31));
	const regions = [{ start: 0, end: endBlock }, { start: size - endBlock, end: size },
		...starts.map(start => ({ start, end: Math.min(size, start + block) }))];
	const ordered: { start: number; end: number }[] = [];
	for (const region of regions.sort((a, b) => a.start - b.start)) {
		const previous = ordered.at(-1);
		if (previous && previous.end >= region.start) previous.end = Math.max(previous.end, region.end);
		else ordered.push(region);
	}
	return ordered;
}
