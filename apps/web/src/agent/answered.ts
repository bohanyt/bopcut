// Revs of requests already answered (frames, changes), per project: the last few are remembered, so a
// request rewritten with an older rev (r1, r2, then r1 again) is not answered twice.
const LIMIT = 32;

function read(key: string): string[] {
	const raw = localStorage.getItem(key);
	if (raw === null) return [];
	try {
		const list = JSON.parse(raw);
		if (Array.isArray(list)) return list.filter((rev): rev is string => typeof rev === "string");
	} catch {
		// an older single rev, stored as is
	}
	return [raw];
}

export function wasAnswered(key: string, rev: string): boolean {
	return read(key).includes(rev);
}

export function markAnswered(key: string, rev: string): void {
	localStorage.setItem(key, JSON.stringify([...read(key).filter((seen) => seen !== rev), rev].slice(-LIMIT)));
}
