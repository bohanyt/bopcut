// Media dragged from a web page (an image search result, any <img>) or pasted as a link, as a File.
// Data URLs are decoded here; http(s) links are fetched by the local server (no CORS limits) into
// AGENT_FILES_ROOT/retrieved/web/ and read back.

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|svg|mp4|webm|mp3|wav|ogg)(\?|#|$)/i;

/** True when a drag carries a link or HTML from another page (not files, not our own timeline drags). */
export function hasWebMedia(types: readonly string[]): boolean {
	return !types.includes("Files") && (types.includes("text/uri-list") || types.includes("text/html"));
}

/** The real image behind search-result links such as `...imgres?imgurl=<image>&...`. */
export function unwrapImageLink(link: string): string {
	try {
		const url = new URL(link);
		const inner = url.searchParams.get("imgurl") ?? url.searchParams.get("mediaurl") ?? url.searchParams.get("img_url");
		if (inner && /^https?:\/\//i.test(inner)) return inner;
	} catch {
		// not a URL
	}
	return link;
}

/**
 * Candidate media links of a drop or paste, best first: an <img> source in the HTML, links that look
 * like media files, then other links (the server checks the type).
 */
export function mediaLinksFrom({ uriList, html, text }: { uriList?: string; html?: string; text?: string }): string[] {
	const links: string[] = [];
	const push = (link: string | undefined | null) => {
		const value = link?.trim();
		if (!value) return;
		if (!/^(https?:|data:(image|video|audio)\/)/i.test(value)) return;
		const unwrapped = value.startsWith("data:") ? value : unwrapImageLink(value);
		if (!links.includes(unwrapped)) links.push(unwrapped);
	};
	const fromUris = (uriList ?? "").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
	// A link wrapping a search result wins over the thumbnail in the HTML.
	for (const uri of fromUris) if (unwrapImageLink(uri) !== uri) push(uri);
	for (const match of (html ?? "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) push(match[1].replace(/&amp;/g, "&"));
	for (const uri of fromUris) if (MEDIA_EXT.test(uri)) push(uri);
	for (const uri of fromUris) push(uri);
	if (text && /^\S+$/.test(text.trim())) push(text);
	return links;
}

/** Bytes of a percent-encoded data URL payload: `%89` is the byte 0x89, other characters are UTF-8. */
export function percentDecodeBytes(payload: string): Uint8Array<ArrayBuffer> {
	const out: number[] = [];
	const encoder = new TextEncoder();
	for (let i = 0; i < payload.length; i++) {
		const hex = payload.slice(i + 1, i + 3);
		if (payload[i] === "%" && /^[0-9a-f]{2}$/i.test(hex)) {
			out.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			const code = payload.codePointAt(i) as number;
			const char = String.fromCodePoint(code);
			out.push(...encoder.encode(char));
			i += char.length - 1;
		}
	}
	return Uint8Array.from(out);
}

/** A data URL as a File, or null when it is malformed (bad base64, unknown shape). */
export function dataUrlToFile(dataUrl: string): File | null {
	const match = /^data:([a-z]+\/[a-z0-9.+-]+)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/i.exec(dataUrl);
	if (!match) return null;
	const [, type, , base64, payload] = match;
	try {
		const bytes: Uint8Array<ArrayBuffer> = base64 ? Uint8Array.from(atob(payload.replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : percentDecodeBytes(payload);
		if (bytes.length === 0) return null;
		const ext = type.split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
		return new File([bytes], `dropped image.${ext}`, { type });
	} catch {
		return null;
	}
}

/** The first candidate that turns into a media file, or null (with the last error). */
export async function fetchWebMedia(links: string[]): Promise<{ file: File | null; error?: string }> {
	let error: string | undefined;
	for (const link of links.slice(0, 4)) {
		if (link.startsWith("data:")) {
			const file = dataUrlToFile(link);
			if (file) return { file };
			continue;
		}
		try {
			const res = await fetch("/api/agent/retrieve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "file", url: link }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = body.error ?? `request failed (${res.status})`;
				continue;
			}
			const file = await fetch(`/api/agent/file?p=${encodeURIComponent(body.path)}`);
			if (!file.ok) continue;
			const blob = await file.blob();
			const ext = String(body.path).split(".").pop() ?? "jpg";
			// The server checked the file's bytes: its type is the one to trust.
			return { file: new File([blob], `${body.name || "web media"}.${ext}`, { type: typeof body.mime === "string" ? body.mime : blob.type }) };
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
	return { file: null, error };
}

/** Links of a DataTransfer (drop or paste). */
export function mediaLinksOf(data: DataTransfer | null): string[] {
	if (!data) return [];
	return mediaLinksFrom({ uriList: data.getData("text/uri-list"), html: data.getData("text/html"), text: data.getData("text/plain") });
}

/**
 * Candidate links per dropped image. A selection holding several distinct images (and no search-result
 * wrapper link) gives one group per image; otherwise all candidates are fallbacks for one image.
 */
export function mediaGroupsFrom(input: { uriList?: string; html?: string; text?: string }): string[][] {
	const all = mediaLinksFrom(input);
	if (all.length === 0) return [];
	const uris = (input.uriList ?? "").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
	const wrapped = uris.some((uri) => unwrapImageLink(uri) !== uri);
	const images = [...new Set([...(input.html ?? "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&").trim()))].filter((src) => /^(https?:|data:(image|video|audio)\/)/i.test(src));
	if (wrapped || images.length < 2) return [all];
	return images.slice(0, 10).map((src) => [src]);
}

/** Candidate groups of a DataTransfer drop, one per image. */
export function mediaGroupsOf(data: DataTransfer | null): string[][] {
	if (!data) return [];
	return mediaGroupsFrom({ uriList: data.getData("text/uri-list"), html: data.getData("text/html"), text: data.getData("text/plain") });
}

/** Links of a paste that clearly point at media: a link to a media file, or HTML holding an image. */
export function pastedMediaLinks(data: DataTransfer | null): string[] {
	if (!data) return [];
	const html = data.getData("text/html");
	const text = data.getData("text/plain").trim();
	const isLink = /^https?:\/\/\S+$/i.test(text);
	const looksLikeMedia = /<img\b/i.test(html) || (isLink && (MEDIA_EXT.test(text) || unwrapImageLink(text) !== text)) || /^data:(image|video|audio)\//i.test(text);
	return looksLikeMedia ? mediaLinksFrom({ html, text }) : [];
}
