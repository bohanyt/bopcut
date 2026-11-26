import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";
const FONT_ATLAS_PATH = "/fonts/font-atlas.json";

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
/** The atlas's family names by lower case, built once per atlas. */
let atlasFamilies: { atlas: FontAtlas; names: Map<string, string> } | null = null;

function encodeGoogleFontsFamily(family: string): string {
	return family.replace(/ /g, "+");
}

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

/** Forgets the atlas so it is fetched again (the picker's Retry); fonts already loaded stay loaded. */
export function clearFontAtlasCache(): void {
	cachedAtlas = null;
	atlasFetchPromise = null;
}

/** Forgets which fonts were loaded (tests). */
export function forgetLoadedFonts(): void {
	fullLoaded.clear();
	fullLoading.clear();
}

/** CSS matches family names without regard to case: one request per family, with the atlas's spelling. */
function familyKey(family: string): string {
	return family.toLowerCase();
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
			// The picker's sprite sheets are not fetched here: its rows load the ones they show.
			cachedAtlas = data;
			return data;
		})
		.catch(() => {
			atlasFetchPromise = null;
			return null;
		});

	return atlasFetchPromise;
}

function atlasFamilyName(atlas: FontAtlas | null, key: string): string | undefined {
	if (!atlas) return undefined;
	if (atlasFamilies?.atlas !== atlas) {
		atlasFamilies = { atlas, names: new Map(Object.keys(atlas.fonts).map((name) => [familyKey(name), name])) };
	}
	return atlasFamilies.names.get(key);
}

/**
 * The faces to request for `family`: the wanted weights the font has, upright and italic. The Google Fonts
 * CSS API refuses a request for a face the family lacks (a 700 of a one-weight display font, or any italic
 * of a family without italics), so the atlas's style list decides. Without an atlas entry the weights are
 * requested as given.
 */
export function fontFaces({ family, weights, atlas = cachedAtlas }: {
	family: string;
	weights: number[];
	atlas?: FontAtlas | null;
}): { weight: number; italic: boolean }[] {
	const styles = atlas?.fonts[family]?.s;
	if (!styles?.length) return weights.map((weight) => ({ weight, italic: false }));
	const available = new Set(styles);
	const faces = [false, true].flatMap((italic) => weights
		.filter((weight) => available.has(`${weight}${italic ? "i" : ""}`))
		.map((weight) => ({ weight, italic })));
	if (faces.length) return faces;
	// None of the wanted weights: take the family's first upright style (or its first style).
	const fallback = styles.find((style) => !style.endsWith("i")) ?? styles[0];
	const weight = Number.parseInt(fallback, 10);
	return Number.isFinite(weight) ? [{ weight, italic: fallback.endsWith("i") }] : weights.map((w) => ({ weight: w, italic: false }));
}

function fontQuery(faces: { weight: number; italic: boolean }[]): string {
	if (!faces.some(({ italic }) => italic)) return `wght@${faces.map(({ weight }) => weight).join(";")}`;
	return `ital,wght@${faces.map(({ weight, italic }) => `${italic ? 1 : 0},${weight}`).join(";")}`;
}

/** Loads a Google font once; concurrent calls share the request, and a failed one is retried next time. */
export function loadFullFont({
	family,
	weights = [400, 700],
}: {
	family: string;
	weights?: number[];
}): Promise<void> {
	const key = familyKey(family);
	if (fullLoaded.has(key)) return Promise.resolve();
	const running = fullLoading.get(key);
	if (running) return running;

	const task = (async () => {
		const atlas = await loadFontAtlas();
		family = atlasFamilyName(atlas, key) ?? family;
		const faces = fontFaces({ family, weights, atlas });
		const url = `${GOOGLE_FONTS_CSS}?family=${encodeGoogleFontsFamily(family)}:${fontQuery(faces)}&display=swap`;
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
			faces.map(({ weight, italic }) =>
				document.fonts.load(`${italic ? "italic " : ""}${weight} 16px "${family.replace(/"/g, '\\"')}"`),
			),
		);
		fullLoaded.add(key);
		for (const listener of [...loadListeners]) listener();
	})().finally(() => {
		if (fullLoading.get(key) === task) fullLoading.delete(key);
	});
	fullLoading.set(key, task);
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
