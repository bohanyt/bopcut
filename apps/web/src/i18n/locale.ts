export type Locale = "en" | "id";

export const LOCALE_COOKIE = "bopencut_locale";

export function resolveLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
	if (cookie === "en" || cookie === "id") return cookie;

	let preferred = "";
	let highestQuality = 0;
	for (const preference of (acceptLanguage ?? "").split(",")) {
		const [tag, weight] = preference.trim().split(";");
		const quality = weight === undefined ? 1 : Number(weight.trim().replace(/^q=/i, ""));
		if (quality > highestQuality && quality <= 1) {
			preferred = tag.toLowerCase();
			highestQuality = quality;
		}
	}
	return preferred === "id" || preferred.startsWith("id-") ? "id" : "en";
}
