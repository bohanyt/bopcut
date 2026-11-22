import Link from "next/link";
import { BasePage } from "./base-page";
import { getServerI18n } from "@/i18n/server";

export default async function NotFound() {
	const { t } = await getServerI18n();
	return (
		<BasePage title={t("site.notFound")} description={t("site.notFoundDescription")}>
			<Link href="/" className="mx-auto underline">{t("site.backHome")}</Link>
		</BasePage>
	);
}
