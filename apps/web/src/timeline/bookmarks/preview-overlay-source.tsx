import type { Bookmark } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import {
	EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
	type PreviewOverlayDefinition,
	type PreviewOverlaySourceResult,
} from "@/preview/overlays";
import { getBookmarksActiveAtTime } from "./utils";

export const bookmarkNotesPreviewOverlay: PreviewOverlayDefinition = {
	id: "bookmark-notes",
	labelKey: "bookmark.showNotes",
	defaultVisible: true,
};

function BookmarkNotesOverlay() {
	const bookmarks = useEditor((editor) =>
		(editor.scenes.getActiveSceneOrNull()?.bookmarks ?? []).filter(
			(bookmark) => bookmark.note?.trim(),
		),
	);
	return bookmarks.length > 0 && <ActiveBookmarkNotes bookmarks={bookmarks} />;
}

function ActiveBookmarkNotes({ bookmarks }: { bookmarks: Bookmark[] }) {
	const active = useEditor((editor) =>
		getBookmarksActiveAtTime({ bookmarks, time: editor.playback.getCurrentTime() }),
	);
	if (active.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5" aria-live="polite">
			{active.map((bookmark) => (
				<div
					key={bookmark.time}
					className="flex max-w-[min(200px,50vw)] px-2.5 py-1.5 text-left text-white text-xs shadow-md backdrop-blur-sm"
					style={{
						backgroundColor: "rgb(0 0 0 / 0.5)",
						borderLeft: bookmark.color
							? `3px solid ${bookmark.color}`
							: "3px solid var(--primary)",
					}}
				>
					{bookmark.note}
				</div>
			))}
		</div>
	);
}

export function getBookmarkPreviewOverlaySource({
	isVisible,
}: {
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	if (!isVisible) {
		return {
			...EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
			definitions: [bookmarkNotesPreviewOverlay],
		};
	}

	return {
		definitions: [bookmarkNotesPreviewOverlay],
		instances: [
			{
				id: bookmarkNotesPreviewOverlay.id,
				mount: { kind: "hud", anchor: "top-left", order: 0 },
				plane: "over-interaction",
				pointerEvents: "none",
				render: () => <BookmarkNotesOverlay />,
			},
		],
	};
}
