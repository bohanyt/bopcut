"use client";

import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "./provider";

export function LanguageSwitch({ refreshOnChange = false }: { refreshOnChange?: boolean }) {
	const router = useRouter();
	const { locale, setLocale, t } = useI18n();

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" data-language-switch aria-label={t("language.label")} title={t("language.label")}>
					<Languages className="size-4" />
					{t(locale === "en" ? "language.enShort" : "language.idShort")}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent data-language-switch align="end" className="z-100">
				<DropdownMenuRadioGroup
					value={locale}
					onValueChange={(value) => {
						if ((value === "en" || value === "id") && value !== locale) {
							setLocale(value);
							if (refreshOnChange) router.refresh();
						}
					}}
				>
					<DropdownMenuRadioItem value="en" lang="en">{t("language.en")}</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="id" lang="id">{t("language.id")}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
