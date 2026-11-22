"use client";

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
import { useStoragePersistence } from "@/services/storage/use-storage-persistence";

export function StoragePersistenceDialog() {
	const { t } = useI18n();
	const { showDialog, onConfirm, onDismiss } = useStoragePersistence();

	return (
		<Dialog open={showDialog} onOpenChange={(open) => !open && onDismiss()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("storage.protectTitle")}</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-base text-muted-foreground">
						{t("storage.protectDescription")}
					</p>
					<p className="text-base text-muted-foreground">
						{t("storage.protectQuestion")}
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onDismiss}>
						{t("storage.notNow")}
					</Button>
					<Button onClick={onConfirm}>{t("storage.allow")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
