import type { Locale } from "@/i18n/locale";

export function formatDate({ date, locale = "en" }: { date: Date; locale?: Locale }): string {
	return date.toLocaleDateString(locale === "id" ? "id-ID" : "en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
