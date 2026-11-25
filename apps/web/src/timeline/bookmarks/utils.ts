import type { Bookmark } from "@/timeline";
import type { FrameRate } from "opencut-wasm";
import { addMediaTime, roundFrameTime, type MediaTime } from "@/wasm";

function bookmarkTimeEqual({
	bookmarkTime,
	frameTime,
}: {
	bookmarkTime: MediaTime;
	frameTime: MediaTime;
}): boolean {
	return bookmarkTime === frameTime;
}

export function findBookmarkIndex({
	bookmarks,
	frameTime,
	bookmark,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
	bookmark?: Bookmark;
}): number {
	if (bookmark) {
		const index = bookmarks.indexOf(bookmark);
		// An agent may have answered or resolved the note since it was read.
		if (index >= 0 || !bookmark.id) return index;
		const sameId = bookmarks.filter(({ id }) => id === bookmark.id);
		return sameId.length === 1 ? bookmarks.indexOf(sameId[0]) : -1;
	}
	return bookmarks.findIndex((bookmark) =>
		bookmarkTimeEqual({ bookmarkTime: bookmark.time, frameTime }),
	);
}

export function isBookmarkAtTime({
	bookmarks,
	frameTime,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
}): boolean {
	return bookmarks.some((bookmark) =>
		bookmarkTimeEqual({ bookmarkTime: bookmark.time, frameTime }),
	);
}

export function toggleBookmarkInArray({
	bookmarks,
	frameTime,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
}): Bookmark[] {
	const bookmarkIndex = findBookmarkIndex({ bookmarks, frameTime });

	if (bookmarkIndex !== -1) {
		return bookmarks.filter((_, index) => index !== bookmarkIndex);
	}

	const newBookmarks = [...bookmarks, { time: frameTime }];
	return newBookmarks.slice().sort((a, b) => a.time - b.time);
}

export function removeBookmarkFromArray({
	bookmarks,
	frameTime,
	bookmark,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
	bookmark?: Bookmark;
}): Bookmark[] {
	const index = findBookmarkIndex({ bookmarks, frameTime, bookmark });
	return index === -1 ? bookmarks : bookmarks.filter((_, i) => i !== index);
}

export function updateBookmarkInArray({
	bookmarks,
	frameTime,
	updates,
	bookmark,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
	updates: Partial<Omit<Bookmark, "time">>;
	bookmark?: Bookmark;
}): Bookmark[] {
	const index = findBookmarkIndex({ bookmarks, frameTime, bookmark });
	if (index === -1) {
		return bookmarks;
	}

	const updated = { ...bookmarks[index], ...updates };
	const result = [...bookmarks];
	result[index] = updated;
	return result;
}

export function moveBookmarkInArray({
	bookmarks,
	fromTime,
	toTime,
	bookmark,
}: {
	bookmarks: Bookmark[];
	fromTime: MediaTime;
	toTime: MediaTime;
	bookmark?: Bookmark;
}): Bookmark[] {
	const index = findBookmarkIndex({ bookmarks, frameTime: fromTime, bookmark });
	if (index === -1 || bookmarks[index].time === toTime || isBookmarkAtTime({ bookmarks, frameTime: toTime })) {
		return bookmarks;
	}

	const updated = { ...bookmarks[index], time: toTime };
	const result = [...bookmarks];
	result[index] = updated;
	return result.slice().sort((a, b) => a.time - b.time);
}

export function getFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): MediaTime {
	return roundFrameTime({ time, fps });
}

export function getBookmarkAtTime({
	bookmarks,
	frameTime,
}: {
	bookmarks: Bookmark[];
	frameTime: MediaTime;
}): Bookmark | null {
	const index = findBookmarkIndex({ bookmarks, frameTime });
	return index === -1 ? null : bookmarks[index];
}

export function getBookmarksActiveAtTime({
	bookmarks,
	time,
}: {
	bookmarks: Bookmark[];
	time: MediaTime;
}): Bookmark[] {
	return bookmarks.filter((bookmark) => {
		const start = bookmark.time;
		const end =
			bookmark.duration != null && bookmark.duration > 0
				? addMediaTime({ a: start, b: bookmark.duration })
				: start;
		return time >= start && time <= end;
	});
}
