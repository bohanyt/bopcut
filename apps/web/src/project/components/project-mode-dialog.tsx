"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon, FilmRoll01Icon, Scissor01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/translate";
import type { ProjectMode } from "@/project/types";
import { cn } from "@/utils/ui";

const MODES = [
	{ mode: "editing", icon: Scissor01Icon, title: "projectMode.editing", description: "projectMode.editingDescription", ready: true },
	{ mode: "creating", icon: FilmRoll01Icon, title: "projectMode.creating", description: "projectMode.creatingDescription", ready: true },
	{ mode: "generating", icon: AiMagicIcon, title: "projectMode.generating", description: "projectMode.generatingDescription", ready: false },
] as const satisfies readonly { mode: ProjectMode; icon: typeof Scissor01Icon; title: MessageKey; description: MessageKey; ready: boolean }[];

export const projectModeLabel = (mode: ProjectMode) => MODES.find((entry) => entry.mode === mode)!.title;

/**
 * Asks what a project is for. A new project can also start without a mode; a project's mode can be
 * changed or cleared. Generating is shown but cannot be chosen yet.
 */
export function ProjectModeDialog({
	isOpen,
	onOpenChange,
	current,
	purpose,
	onChoose,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	/** The mode the project has now (only when changing one). */
	current?: ProjectMode | null;
	purpose: "new" | "change";
	onChoose: (mode: ProjectMode | null) => void;
}) {
	const { t } = useI18n();
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t(purpose === "new" ? "projectMode.newTitle" : "projectMode.changeTitle")}</DialogTitle>
					<DialogDescription>{t("projectMode.agentNote")}</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-4">
					<div className="grid gap-3 sm:grid-cols-3">
						{MODES.map(({ mode, icon, title, description, ready }) => (
							<button
								key={mode}
								type="button"
								disabled={!ready}
								aria-pressed={purpose === "change" ? current === mode : undefined}
								onClick={() => onChoose(mode)}
								className={cn(
									"flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors",
									"hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
									current === mode && "border-primary bg-accent",
								)}
							>
								<HugeiconsIcon icon={icon} className="size-6" />
								<span className="font-medium">{t(title)}</span>
								<span className="text-muted-foreground text-xs leading-relaxed">{t(description)}</span>
								{!ready && <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{t("projectMode.comingSoon")}</span>}
							</button>
						))}
					</div>
					<div className="flex justify-end">
						<Button variant="text" className="text-muted-foreground" onClick={() => onChoose(null)}>
							{t(purpose === "new" ? "projectMode.skip" : "projectMode.none")}
						</Button>
					</div>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
