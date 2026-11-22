export function mediaIdsInScenes(scenes: readonly { tracks: { main: { elements: readonly unknown[] }; overlay: readonly { elements: readonly unknown[] }[]; audio: readonly { elements: readonly unknown[] }[] } }[]): Set<string> {
	const ids = new Set<string>();
	for (const scene of scenes) {
		for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
			for (const element of track.elements as { mediaId?: unknown }[]) if (typeof element.mediaId === "string") ids.add(element.mediaId);
		}
	}
	return ids;
}
