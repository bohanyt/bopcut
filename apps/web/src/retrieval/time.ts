// Time and request helpers for media retrieval. Pure functions, safe on the client and the server.

/** Seconds from "90", "90.5", "1:30", "01:02:03.25", "1h2m3s", "2m" or "45s". NaN when invalid. */
export function parseTime(input: string | number): number {
	if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : Number.NaN;
	const s = input.trim().toLowerCase();
	if (!s) return Number.NaN;
	if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
	const colon = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
	if (colon) {
		const [, h, m, sec] = colon;
		if (Number(sec) >= 60 || (h !== undefined && Number(m) >= 60)) return Number.NaN;
		return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(sec);
	}
	const units = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
	if (units && (units[1] || units[2] || units[3])) {
		return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
	}
	return Number.NaN;
}

/** "1:02:03.5" / "2:03" style label for names and messages. */
export function formatTime(seconds: number): string {
	const tenths = Math.round(Math.max(0, seconds) * 10);
	const whole = Math.floor(tenths / 10);
	const tenth = tenths % 10;
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	const sec = `${String(s).padStart(2, "0")}${tenth ? `.${tenth}` : ""}`;
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Start time carried by a link (`t=`, `start=` or `#t=`), in seconds; undefined when absent or invalid. */
export function timeFromUrl(url: string): number | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const raw =
		parsed.searchParams.get("t") ??
		parsed.searchParams.get("start") ??
		new URLSearchParams(parsed.hash.replace(/^#/, "")).get("t");
	if (raw == null) return undefined;
	const seconds = parseTime(raw);
	return Number.isNaN(seconds) ? undefined : seconds;
}

/** Page link that opens at `start` where the site supports it (YouTube `t=`), otherwise the page URL itself. */
export function linkAt(pageUrl: string, start: number): string {
	try {
		const parsed = new URL(pageUrl);
		if (/(^|\.)(youtube\.com|youtu\.be)$/.test(parsed.hostname)) {
			parsed.searchParams.set("t", `${Math.floor(start)}s`);
			return parsed.toString();
		}
	} catch {
		// not a URL: return as is
	}
	return pageUrl;
}

export function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export type SectionRequest = { url: string; start: number; end: number; height?: number; audioOnly?: boolean };
export type FrameRequest = { url: string; time: number; width?: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function readTime(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
	return parseTime(value);
}

/**
 * Validates a section request. `start` falls back to the link's own `t=`; `end` may be given as
 * `duration`. Sections longer than `maxSeconds` are refused (whole videos are never fetched).
 */
export function normalizeSectionRequest(
	input: { url?: unknown; start?: unknown; end?: unknown; duration?: unknown; height?: unknown; audioOnly?: unknown },
	maxSeconds: number,
): Result<SectionRequest> {
	if (!isHttpUrl(input.url)) return { ok: false, error: "url must be an http(s) link" };
	const url = input.url;
	const start = readTime(input.start) ?? timeFromUrl(url);
	if (start === undefined) return { ok: false, error: "start is required (seconds, 1:02:03, or a link with t=)" };
	if (Number.isNaN(start)) return { ok: false, error: "start is not a valid time" };
	const duration = readTime(input.duration);
	const end = readTime(input.end) ?? (duration !== undefined && !Number.isNaN(duration) ? start + duration : undefined);
	if (end === undefined) return { ok: false, error: "end or duration is required" };
	if (Number.isNaN(end) || (duration !== undefined && Number.isNaN(duration))) return { ok: false, error: "end is not a valid time" };
	if (end <= start) return { ok: false, error: "end must be after start" };
	if (end - start > maxSeconds) {
		return { ok: false, error: `section is ${Math.round(end - start)} s; the limit is ${maxSeconds} s; request a shorter range` };
	}
	let height: number | undefined;
	if (input.height !== undefined && input.height !== null && input.height !== "") {
		height = Number(input.height);
		if (!Number.isInteger(height) || height < 144 || height > 4320) return { ok: false, error: "height must be an integer from 144 to 4320" };
	}
	if (input.audioOnly !== undefined && typeof input.audioOnly !== "boolean") return { ok: false, error: "audioOnly must be true or false" };
	return { ok: true, value: { url, start, end, ...(height ? { height } : {}), ...(input.audioOnly ? { audioOnly: true } : {}) } };
}

export function normalizeFrameRequest(input: { url?: unknown; time?: unknown; width?: unknown }): Result<FrameRequest> {
	if (!isHttpUrl(input.url)) return { ok: false, error: "url must be an http(s) link" };
	const time = readTime(input.time) ?? timeFromUrl(input.url);
	if (time === undefined || Number.isNaN(time)) return { ok: false, error: "time is required (seconds, 1:02:03, or a link with t=)" };
	let width: number | undefined;
	if (input.width !== undefined && input.width !== null && input.width !== "") {
		width = Number(input.width);
		if (!Number.isInteger(width) || width < 64 || width > 3840) return { ok: false, error: "width must be an integer from 64 to 3840" };
	}
	return { ok: true, value: { url: input.url, time, ...(width ? { width } : {}) } };
}
