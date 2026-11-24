"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import { Loader2 } from "lucide-react";

export function MigrationDialog() {
	const { t } = useI18n();
	const editor = useEditor();
	const migrationState = editor.project.getMigrationState();

	if (!migrationState.isMigrating) return null;

	const title = migrationState.projectName
		? t("migration.updatingOne")
		: t("migration.updatingMany");
	const description = migrationState.projectName
		? t("migration.upgrading", {
				name: migrationState.projectName,
				from: migrationState.fromVersion ?? 0,
				to: migrationState.toVersion ?? 0,
			})
		: t("migration.upgradingProjects", {
				from: migrationState.fromVersion ?? 0,
				to: migrationState.toVersion ?? 0,
			});

	return (
		<Dialog open={true}>
			<DialogContent
				className="sm:max-w-md"
				onPointerDownOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-center py-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
				</div>
			</DialogContent>
		</Dialog>
	);
}
