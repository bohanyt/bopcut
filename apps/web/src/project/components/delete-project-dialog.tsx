import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useId, useState } from "react";

const DELETE_KEYWORD = "DELETE";

export function DeleteProjectDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	projectNames: readonly string[];
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<DeleteProjectConfirmation
					isOpen={isOpen}
					projectNames={projectNames}
					onCancel={() => onOpenChange(false)}
					onConfirm={onConfirm}
				/>
			</DialogContent>
		</Dialog>
	);
}

export function DeleteProjectConfirmation({
	isOpen,
	projectNames,
	onCancel,
	onConfirm,
}: {
	isOpen: boolean;
	projectNames: readonly string[];
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { t } = useI18n();
	const confirmationId = useId();
	const [confirmation, setConfirmation] = useState("");
	if (!isOpen) {
		if (confirmation) setConfirmation("");
		return null;
	}
	const canDelete = confirmation === DELETE_KEYWORD;
	const count = projectNames.length;
	const isSingle = count === 1;
	const singleName = isSingle ? projectNames[0] : null;

	return (
		<>
			<DialogHeader>
				<DialogTitle className="min-w-0 break-words pr-6">
					{singleName
						? t("projects.deleteNamed", { name: singleName })
						: t("projects.deleteMultiple", { count })}
				</DialogTitle>
			</DialogHeader>
			<DialogBody>
				<Alert variant="destructive">
					<AlertTitle>{t("projects.warning")}</AlertTitle>
					<AlertDescription className="break-words">
						{singleName
							? t("projects.deleteNamedWarning", { name: singleName })
							: t("projects.deleteMultipleWarning", { count })}
					</AlertDescription>
				</Alert>
				<div className="flex flex-col gap-3">
					<Label
						htmlFor={confirmationId}
						className="text-xs font-semibold text-slate-500"
					>
						{t("projects.confirmDelete", { keyword: DELETE_KEYWORD })}
					</Label>
					<Input
						type="text"
						id={confirmationId}
						placeholder={DELETE_KEYWORD}
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
						size="lg"
						variant="destructive"
					/>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="outline" onClick={onCancel}>
					{t("common.cancel")}
				</Button>
				<Button
					variant="destructive"
					disabled={!canDelete}
					onClick={() => {
						if (canDelete) onConfirm();
					}}
				>
					{t("projects.deleteProject")}
				</Button>
			</DialogFooter>
		</>
	);
}
