import { getBrowserTranslator } from "@/i18n/browser";
import { toast } from "sonner";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(async () => {
		await waitForNextPaint();
		return run();
	}, {
		loading: filesCount === 1 ? getBrowserTranslator()("media.uploadOne") : getBrowserTranslator()("media.uploadMany"),
		success: ({ uploadedCount, assetNames }) => {
			if (uploadedCount === 1) {
				const assetName = assetNames?.[0];
				return assetName
					? getBrowserTranslator()("media.uploadedNamed", { name: assetName })
					: getBrowserTranslator()("media.uploadedOne");
			}

			if (uploadedCount > 1) {
				return getBrowserTranslator()("media.uploadedMany", { count: uploadedCount });
			}

			return getBrowserTranslator()("media.uploadedNone");
		},
		error: () => filesCount === 1 ? getBrowserTranslator()("media.uploadOneFailed") : getBrowserTranslator()("media.uploadManyFailed"),
	});

	return toastPromise.unwrap();
}
