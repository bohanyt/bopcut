import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";
const FONT_ATLAS_PATH = "/fonts/font-atlas.json";
const FONT_CHUNK_PATH_PREFIX = "/fonts/font-chunk-";

const fullLoaded = new Set<string>();
const fullLoading = new Map<string, Promise<void>>();
const loadListeners = new Set<() => void>();

/** Calls `listener` each time a font finished loading, so text drawn with its fallback is drawn again. */
export function subscribeFontLoads(listener: () => void): () => void {
	loadListeners.add(listener);
	return () => loadListeners.delete(listener);
}

let cachedAtlas: FontAtlas | null = null;
let atlasFetchPromise: Promise<FontAtlas | null> | null = null;

function encodeGoogleFontsFamily(family: string): string {
	return family.replace(/ /g, "+");
}

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

export function clearFontAtlasCache(): void {
	cachedAtlas = null;
	atlasFetchPromise = null;
	fullLoaded.clear();
	fullLoading.clear();
}

export function loadFontAtlas(): Promise<FontAtlas | null> {
	if (cachedAtlas) return Promise.resolve(cachedAtlas);
	if (atlasFetchPromise) return atlasFetchPromise;

	atlasFetchPromise = fetch(FONT_ATLAS_PATH)
		.then(async (response) => {
			if (!response.ok) {
				atlasFetchPromise = null;
				return null;
			}
			const data: FontAtlas = await response.json();
			cachedAtlas = data;
			preloadChunkImages({ atlas: data });
			return data;
		})
		.catch(() => {
			atlasFetchPromise = null;
			return null;
		});

	return atlasFetchPromise;
}

function preloadChunkImages({ atlas }: { atlas: FontAtlas }): void {
	const maxChunk = Math.max(
		...Object.values(atlas.fonts).map((entry) => entry.ch),
	);
	for (let i = 0; i <= maxChunk; i++) {
		// hint browser to preload chunk images without blocking
		const img = new Image();
		img.src = `${FONT_CHUNK_PATH_PREFIX}${i}.avif`;
	}
}

/** Loads a Google font once; concurrent calls share the request, and a failed one is retried next time. */
export function loadFullFont({
	family,
	weights = [400, 700],
}: {
	family: string;
	weights?: number[];
}): Promise<void> {
	if (fullLoaded.has(family)) return Promise.resolve();
	const running = fullLoading.get(family);
	if (running) return running;

	const task = (async () => {
		const url = `${GOOGLE_FONTS_CSS}?family=${encodeGoogleFontsFamily(family)}:wght@${weights.join(";")}&display=swap`;
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		document.head.appendChild(link);
		const loaded = await new Promise<boolean>((resolve) => {
			link.addEventListener("load", () => resolve(true), { once: true });
			link.addEventListener("error", () => resolve(false), { once: true });
		});
		if (!loaded) {
			link.remove();
			return;
		}
		await Promise.all(
			weights.map((weight) =>
				document.fonts.load(`${weight} 16px "${family.replace(/"/g, '\\"')}"`),
			),
		);
		fullLoaded.add(family);
		for (const listener of [...loadListeners]) listener();
	})().finally(() => {
		if (fullLoading.get(family) === task) fullLoading.delete(family);
	});
	fullLoading.set(family, task);
	return task;
}

export async function loadFonts({
	families,
}: {
	families: string[];
}): Promise<void> {
	const googleFonts = families.filter((family) => !SYSTEM_FONTS.has(family));
	await Promise.all(googleFonts.map((family) => loadFullFont({ family })));
}
