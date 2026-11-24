import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useEditor } from "@/editor/use-editor";
import { isModelFile } from "./media-utils";
import type { MediaAsset } from "./types";

let observer: IntersectionObserver | undefined;
const targets = new WeakMap<Element, (visible: boolean) => void>();

export function useVisibleThumbnail(asset?: MediaAsset) {
	const editor = useEditor();
	const ref = useRef<HTMLDivElement>(null);
	const id = asset?.thumbnailUrl ? undefined : asset?.id;
	const subscribe = useCallback((listener: () => void) =>
		id === undefined ? () => {} : editor.media.subscribeThumbnail(id, listener), [editor, id]);
	const read = () => asset?.thumbnailUrl;
	const thumbnailUrl = useSyncExternalStore(subscribe, read, read);

	useEffect(() => {
		const node = ref.current;
		if (!node || !asset || thumbnailUrl || editor.renderOnly ||
			(asset.type !== "video" && (asset.type !== "image" || isModelFile(asset.file))) ||
			typeof IntersectionObserver === "undefined") return;
		let release: (() => void) | undefined;
		observer ??= new IntersectionObserver((entries) => {
			for (const entry of entries) {
				targets.get(entry.target)?.(entry.isIntersecting && entry.intersectionRatio > 0);
			}
		});
		targets.set(node, (visible) => {
			if (visible) release ??= editor.media.requestThumbnail(asset);
			else {
				release?.();
				release = undefined;
			}
		});
		observer.observe(node);
		return () => {
			observer?.unobserve(node);
			targets.delete(node);
			release?.();
		};
	}, [asset, editor, thumbnailUrl]);

	return { ref, thumbnailUrl };
}
