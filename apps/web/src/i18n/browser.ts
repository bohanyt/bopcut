import { createTranslator } from "./translate";

const translators = { en: createTranslator("en"), id: createTranslator("id") };

/** Translate notifications emitted outside React using the current page language. */
export function getBrowserTranslator() {
	return typeof document !== "undefined" && document.documentElement?.lang === "id"
		? translators.id
		: translators.en;
}
