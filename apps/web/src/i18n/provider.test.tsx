import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider, useI18n } from "./provider";

function ProjectLabel() {
	const { locale, t } = useI18n();
	return <span lang={locale}>{t("projects.all")}</span>;
}

test("the initial render uses the request locale", () => {
	expect(renderToStaticMarkup(
		<LocaleProvider initialLocale="id"><ProjectLabel /></LocaleProvider>,
	)).toBe('<span lang="id">Semua proyek</span>');
});
