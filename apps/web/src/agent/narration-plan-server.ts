import { parseSourceWords } from "@/media/words";
import { MAX_NARRATION_WORDS } from "./narration-alignment";
import { planNarration } from "./narration-plan";
import { orderedTracks } from "./scene-graph";
import { readReviewableProject } from "./transcript-view-server";

export async function readNarrationPlan({ projectId, clipId, mediaId, timeoutMs, signal }: {
	projectId: string; clipId: string; mediaId: string; timeoutMs: number; signal: AbortSignal;
}) {
	const deadline = performance.now() + timeoutMs;
	const check = () => {
		signal.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("Timed out while planning the narration replacement.");
	};
	let oldId: string | undefined;
	const { root, project, media } = await readReviewableProject(projectId, signal, {
		includeStaged: false,
		mediaIds: (scene) => {
			check();
			const clip = scene && orderedTracks(scene.tracks).flatMap((track) => [...track.elements]).find((item) => item.id === clipId);
			if (clip?.type !== "audio" || clip.sourceType !== "upload" || (clip.retime?.rate ?? 1) !== 1) {
				throw new Error("Select one unretimed, uploaded audio clip in the saved root scene.");
			}
			oldId = clip.mediaId;
			return [oldId, mediaId];
		},
	});
	const previous = media.find((item) => item.id === oldId);
	const replacement = media.find((item) => item.id === mediaId);
	if (!root || !previous || !replacement || replacement.type !== "audio") {
		throw new Error("Choose saved narration and replacement audio from this project's media bin.");
	}
	if ([previous.words, replacement.words].some((words) => Array.isArray(words) && words.length > MAX_NARRATION_WORDS)) {
		throw new Error("Each transcript supports up to 5,000 words.");
	}
	const oldWords = parseSourceWords(previous.words), newWords = parseSourceWords(replacement.words);
	if (!oldWords || !newWords) throw new Error("Both recordings need valid saved word timings.");
	const plan = planNarration({ root, fps: project.settings.fps, clipId, mediaId, oldWords, newWords,
		newDuration: replacement.duration ?? NaN, check });
	return { projectId, ...plan };
}

export function formatNarrationPlan(plan: Awaited<ReturnType<typeof readNarrationPlan>>) {
	const { totals, spans } = plan;
	const rows = spans.items.slice(0, 8).map((span) => {
		const before = span.old.words.join(" "), after = span.next.words.join(" ");
		const preview = before === after ? before : `${before} → ${after}`;
		const words = preview.length <= 120 ? preview : `${preview.slice(0, 117)}...`;
		return `${span.old.start.toFixed(3)}s → ${span.next.start.toFixed(3)}s (${span.shiftSeconds.toFixed(3)}s), ${span.confidence}: ${words}`;
	});
	const conflicts = totals.needsMoreSource + totals.shorterThanProtectedContent + totals.crossesUnresolvedChange;
	return [
		`Narration ${plan.clipId}: ${totals.move} moves, ${totals.trim} trims, ${conflicts} conflicts, ${totals.unanchored} unanchored.`,
		`${totals.unmatched} unmatched old words, ${totals.inserted} inserted or unresolved new words.`,
		...rows, "Use --json for exact times, frame positions, element addresses, and omitted counts.", "",
	].join("\n");
}
