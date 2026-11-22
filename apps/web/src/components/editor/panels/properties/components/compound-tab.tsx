"use client";

import { useI18n } from "@/i18n/provider";
import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import type { CompoundElement } from "@/timeline";

export function CompoundTab({
	element,
	trackId,
}: {
	element: CompoundElement;
	trackId: string;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const [draft, setDraft] = useState<string | null>(null);

	const commitName = () => {
		const name = draft?.trim();
		setDraft(null);
		if (!name || name === element.name) return;
		editor.timeline.renameCompound({ sceneId: element.sceneId, name });
	};

	return (
		<Section sectionKey={`${element.id}:compound`}>
			<SectionHeader>
				<SectionTitle>{t("properties.compound")}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label={t("common.name")}>
						<Input
							size="sm"
							aria-label={t("properties.compoundName")}
							value={draft ?? element.name}
							onChange={(event) => setDraft(event.target.value)}
							onBlur={commitName}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
					</SectionField>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							onClick={() =>
								void editor.scenes.enterCompound({
									trackId,
									elementId: element.id,
								})
							}
						>
							{t("common.open")}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							onClick={() =>
								editor.timeline.ungroupCompound({
									trackId,
									elementId: element.id,
								})
							}
						>
							{t("timeline.breakApart")}
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						{t("properties.compoundHint")}
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
