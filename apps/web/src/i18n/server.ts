import { cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale } from "./locale";
import { createTranslator } from "./translate";

export const getServerI18n = cache(async () => {
	const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
	const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, requestHeaders.get("accept-language"));
	return { locale, t: createTranslator(locale) };
});
