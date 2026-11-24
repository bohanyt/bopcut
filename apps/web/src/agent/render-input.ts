export const MAX_FRAMES = 64;

export function parseFrameInput({ times, elements, noteId, sceneId, width, allowMissing }: Record<string, unknown>) {
	if (times !== undefined && (!Array.isArray(times) || !times.length || times.length > MAX_FRAMES ||
		times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0))) {
		throw new Error("Pass up to 64 non-negative times in seconds to --times.");
	}
	if (elements !== undefined && (!Array.isArray(elements) || !elements.length || elements.length > MAX_FRAMES ||
		elements.some((id) => typeof id !== "string" || !id.trim()))) {
		throw new Error("Pass up to 64 element IDs or agent IDs to --element.");
	}
	if (noteId !== undefined && (typeof noteId !== "string" || !noteId.trim() || noteId.length > 128)) throw new Error("Pass a note ID to --note.");
	if (sceneId !== undefined && (noteId === undefined || typeof sceneId !== "string" || !sceneId.trim() || sceneId.length > 128)) throw new Error("Use --scene-id with --note.");
	if ([times, elements, noteId].filter((value) => value !== undefined).length !== 1) throw new Error("Use one of --times, --element, or --note.");
	if (width !== undefined && (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > 4096)) {
		throw new Error("Set --width to a whole number between 1 and 4096.");
	}
	return { ...(times !== undefined && { times }), ...(elements !== undefined && { elements }), ...(noteId !== undefined && { noteId }), ...(sceneId !== undefined && { sceneId }), ...(width !== undefined && { width }), allowMissing: allowMissing === true };
}
