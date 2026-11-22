import { useI18n } from "@/i18n/provider";
import { PlusSignIcon, RulerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import type { GuideDefinition } from "@/guides/types";

function CustomGuideOptions() {
	const { t } = useI18n();
	return (
		<div className="flex gap-2">
			<Button variant="outline" size="sm" className="flex-1">
				<HugeiconsIcon icon={PlusSignIcon} />
				{t("guides.addLine")}
			</Button>
		</div>
	);
}

export const customGuide = {
	id: "custom",
	labelKey: "guides.custom",
	renderPreview: () => <HugeiconsIcon size={16} icon={RulerIcon} />,
	renderTriggerIcon: () => <HugeiconsIcon icon={RulerIcon} />,
	renderOverlay: () => null,
	renderOptions: () => <CustomGuideOptions />,
} as const satisfies GuideDefinition;
