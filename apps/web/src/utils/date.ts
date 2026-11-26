import type { Locale } from "@/i18n/locale";

export function formatDate({ date, locale = "en" }: { date: Date; locale?: Locale }): string {
	return date.toLocaleDateString(locale === "id" ? "id-ID" : "en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/** A date with its time, for things made today as often as last week. */
export function formatDateTime({ date, locale = "en" }: { date: Date; locale?: Locale }): string {
	return date.toLocaleString(locale === "id" ? "id-ID" : "en-US", { dateStyle: "medium", timeStyle: "short" });
}
