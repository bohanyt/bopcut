"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { LOCALE_COOKIE, type Locale } from "./locale";
import { createTranslator } from "./translate";

const LocaleContext = createContext({
	locale: "en" as Locale,
	t: createTranslator("en"),
	setLocale: (_locale: Locale) => {},
});

export function LocaleProvider({
	initialLocale,
	children,
}: {
	initialLocale: Locale;
	children: ReactNode;
}) {
	const [locale, setCurrentLocale] = useState(initialLocale);
	const value = useMemo(() => ({
		locale,
		t: createTranslator(locale),
		setLocale(nextLocale: Locale) {
			const secure = window.location.protocol === "https:" ? "; Secure" : "";
			document.cookie = `${LOCALE_COOKIE}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
			document.documentElement.lang = nextLocale;
			setCurrentLocale(nextLocale);
		},
	}), [locale]);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
	return useContext(LocaleContext);
}
