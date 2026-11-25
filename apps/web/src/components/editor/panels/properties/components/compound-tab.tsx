"use client";

import { useI18n } from "@/i18n/provider";
import { useEffect, useRef, useState } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
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
	const pending = useRef<string | null>(null);
	const session = useRef(editor.project.getSession());

	const commitName = useCommittedRef(() => {
		const name = pending.current?.trim();
		pending.current = null;
		if (!name || editor.project.getSession() !== session.current) return;
		const scene = editor.scenes.getScenes().find(({ id }) => id === element.sceneId);
		if (scene?.kind === "compound" && scene.name !== name) {
			editor.timeline.renameCompound({ sceneId: scene.id, name });
		}
	});
	useEffect(() => () => commitName.current(), [commitName]);

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
							onChange={(event) => {
								pending.current = event.currentTarget.value;
								setDraft(pending.current);
							}}
							onBlur={() => {
								commitName.current();
								setDraft(null);
							}}
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
