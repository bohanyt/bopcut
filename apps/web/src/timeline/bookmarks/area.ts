/** A rectangle in normalized picture coordinates, independent of the preview viewport. */
export type BookmarkBox = { x: number; y: number; width: number; height: number };
export type PicturePoint = { x: number; y: number };

const MIN_SIZE = 0.01;
const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));

export function boxBetween(a: PicturePoint, b: PicturePoint): BookmarkBox {
	const width = Math.max(MIN_SIZE, Math.abs(clamp(a.x) - clamp(b.x)));
	const height = Math.max(MIN_SIZE, Math.abs(clamp(a.y) - clamp(b.y)));
	return { x: clamp(Math.min(a.x, b.x), 1 - width), y: clamp(Math.min(a.y, b.y), 1 - height), width, height };
}

export function normalizeBookmarkBox(value: unknown): BookmarkBox | undefined {
	if (!value || typeof value !== "object") return;
	const { x, y, width, height } = value as Partial<BookmarkBox>;
	if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
		![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
	if (x >= 0 && y >= 0 && width >= MIN_SIZE && height >= MIN_SIZE && x + width <= 1 && y + height <= 1) return { x, y, width, height };
	return boxBetween({ x, y }, { x: x + width, y: y + height });
}

export function picturePoint(client: PicturePoint, rect: { left: number; top: number; width: number; height: number }): PicturePoint {
	return { x: clamp((client.x - rect.left) / Math.max(1, rect.width)), y: clamp((client.y - rect.top) / Math.max(1, rect.height)) };
}
