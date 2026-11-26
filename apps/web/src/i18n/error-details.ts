import { getCanvasIssueMessage } from "./canvas-messages";
import type { createTranslator, StaticMessageKey } from "./translate";

// Protocol messages are stable. Translate known details where they are shown to people.
const messageKeys = new Map<string, StaticMessageKey>([
	["url must be an http(s) link", "retrieval.url"],
	["start is required (seconds, 1:02:03, or a link with t=)", "retrieval.startRequired"],
	["start is not a valid time", "retrieval.invalidStart"],
	["end or duration is required", "retrieval.endRequired"],
	["end is not a valid time", "retrieval.invalidEnd"],
	["end must be after start", "retrieval.endOrder"],
	["this is a playlist link; use the link of one video", "retrieval.playlist"],
	["not a valid link", "retrieval.invalidLink"],
	["links to this machine or the local network are not fetched (set BOPENCUT_ALLOW_PRIVATE_URLS=1 to allow)", "retrieval.privateLink"],
	["too many redirects", "retrieval.redirects"],
	["this link is a live stream that is still running; use it once the replay is available", "retrieval.live"],
	["nothing was downloaded (a live stream that is still running, or an unsupported link)", "retrieval.noDownload"],
	["the link gave an empty file", "retrieval.emptyFile"],
	["SVG images are not supported; use a PNG or JPEG of it", "retrieval.svg"],
	["the fetched file could not be read", "retrieval.unreadable"],
	["the saved file could not be read", "sounds.unreadable"],
	["Failed to load sounds", "sounds.loadFailed"],
	["Failed to load saved sounds", "sounds.savedLoadFailed"],
	["Failed to submit", "feedback.submitFailed"],
	["No audio track found", "media.noAudioTrack"],
	["No video track found in the file", "media.noVideoTrack"],
	["The track has missing packet data", "media.incompleteTrack"],
	["No video frames could be decoded", "media.noDecodedFrames"],
	["The file does not have a finite video duration", "media.invalidVideoDuration"],
	["Could not load text presets", "text.presetsLoadFailed"],
	["Invalid preset list", "text.invalidPresetList"],
	["Could not save text preset", "text.presetSaveFailed"],
	["Unsupported subtitle format", "captions.unsupportedFormat"],
	["Cannot delete main scene", "timeline.cannotDeleteMain"],
	["Scene is used by a compound clip", "timeline.sceneInUse"],
	["Compound clip was not created", "timeline.compoundNotCreated"],
	["A rename of this project is still being saved; try again in a moment", "projects.renamePending"],
	["The project kept changing while it was reopened", "projects.changedWhileOpening"],
	["This project was made with a newer version of bopencut. Update bopencut to open it.", "projects.newerVersion"],
	["This project does not have a valid version. Open it with a compatible editor and save it again.", "projects.invalidVersion"],
	["a save of it is still running; try again in a moment", "projects.savePending"],
	["The project kept changing; try again", "storage.projectChanging"],
	["The project was deleted; not saved", "storage.projectDeleted"],
	["The editor's server does not answer", "storage.serverAway"],
	["This project is being deleted", "projects.deleting"],
	["the project is still loading", "projects.stillLoading"],
	["saving is off", "storage.saveOff"],
	["save did not finish", "storage.saveIncomplete"],
	["save did not finish; it is retried in the background", "storage.saveRetryBackground"],
	["Unknown export error", "export.unknownError"],
	["No active project", "projects.noneActive"],
	["Project is empty", "export.empty"],
	["Clipboard image copy is not supported in this browser", "preview.clipboardUnavailable"],
	["No project or scene to capture", "preview.noSnapshotScene"],
	["Scene not found", "timeline.sceneNotFound"],
	["Failed to create image", "preview.imageCreationFailed"],
	["Unknown error", "common.unknownError"],
	["an op of this atomic draft failed; nothing was applied", "agentToast.atomicFailed"],
	["every op was stale; nothing was applied (re-read the snapshot and resend)", "agentToast.allStale"],
	["no op could be applied; nothing was applied", "agentToast.noOpsApplied"],
	["another project was opened before the draft ran; nothing was applied", "agentToast.projectSwitched"],
	["no project was open when the draft was queued", "agentToast.noProject"],
	["basedOn must be the syncedAt string of a snapshot", "agentToast.invalidBase"],
	["basedOn is unknown (the editor reloaded or the snapshot is too old); re-read the snapshot and resend", "agentToast.unknownBase"],
	["basedOn belongs to a different project or root scene; re-read the snapshot and resend", "agentToast.wrongBase"],
	["Canvas width and height must be positive whole numbers.", "settings.canvasInvalid"],
	["Graphics device is starting or recovering. Try again when it is ready.", "export.graphicsNotReady"],
	["Graphics device was lost. Try again after graphics recovery.", "export.graphicsLost"],
	["The graphics surface is temporarily unavailable. Try again.", "export.graphicsSurface"],
	["Failed to get target canvas context", "preview.canvasContextFailed"],
	["No active scene.", "timeline.noActiveScene"],
	["No elements to put in a compound clip", "timeline.compoundEmpty"],
	["Some selected elements were not found in the scene", "timeline.compoundSelectionMissing"],
	["These clips cannot be grouped without changing the layer order. Include the overlapping clips or select fewer clips.", "timeline.compoundLayerConflict"],
	["Compound clip not found", "timeline.compoundNotFound"],
]);

export function localizeErrorDetail(detail: string, t: ReturnType<typeof createTranslator>): string {
	const key = messageKeys.get(detail);
	if (key) return t(key);

	let match: RegExpExecArray | null;
	if ((match = /^The (\d+) × (\d+) canvas exceeds this graphics device’s limit of (\d+) pixels per side\. Reduce the canvas size in Project Settings\.$/.exec(detail))) {
		return getCanvasIssueMessage({
			kind: "canvasOverLimit",
			width: Number(match[1]),
			height: Number(match[2]),
			max: Number(match[3]),
		}, t);
	}
	if ((match = /^section is (\d+) s; the limit is (\d+) s \(whole videos are not fetched\)$/.exec(detail))) {
		return t("retrieval.sectionLimit", { seconds: match[1], limit: match[2] });
	}
	if ((match = /^the link's host could not be resolved: (.+)$/.exec(detail))) {
		return t("retrieval.host", { host: match[1] });
	}
	if ((match = /^the file is larger than (\d+) MB$/.exec(detail))) {
		return t("retrieval.fileSize", { size: match[1] });
	}
	if ((match = /^the link answered (\d+)$/.exec(detail))) {
		return t("retrieval.httpStatus", { status: match[1] });
	}
	if ((match = /^the link is not a supported image, video or sound \((.+)\)$/.exec(detail))) {
		return t("retrieval.unsupported", { type: match[1] });
	}
	if ((match = /^request failed \((\d+)\)$/.exec(detail))) {
		return t("network.requestFailed", { status: match[1] });
	}
	if ((match = /^Failed to fetch: (\d+)$/.exec(detail))) {
		return t("network.fetchFailed", { status: match[1] });
	}
	if ((match = /^(.+) was not found\. Install it or set ([A-Z0-9_]+)\.$/.exec(detail))) {
		return t("retrieval.toolMissing", { tool: match[1], setting: match[2] });
	}
	if ((match = /^Could not download the link: (.+)$/i.exec(detail))) {
		return t("retrieval.downloadFailed", { detail: localizeErrorDetail(match[1], t) });
	}
	if ((match = /^Project with id (.+) not found$/.exec(detail))) {
		return t("projects.idNotFound", { id: match[1] });
	}
	if ((match = /^Earlier changes of this project are not saved yet: (.+)$/.exec(detail))) {
		return t("projects.earlierChangesUnsaved", { detail: localizeErrorDetail(match[1], t) });
	}
	if ((match = /^Storage failed \((\d+)\): ([\s\S]*)$/.exec(detail))) {
		return t("storage.requestFailed", { status: match[1], detail: match[2] });
	}
	if ((match = /^Failed to download audio: (.+)$/.exec(detail))) {
		return t("sounds.downloadFailed", { detail: match[1] });
	}
	if ((match = /^Cannot (undo|redo) the agent draft: a scene it changed no longer exists$/.exec(detail))) {
		return t("agentToast.historySceneGone", { action: t(match[1] === "undo" ? "shortcuts.action.undo" : "shortcuts.action.redo") });
	}
	if ((match = /^Cannot (undo|redo) the agent draft: (\d+) scenes it changed no longer exist$/.exec(detail))) {
		return t("agentToast.historyScenesGone", { action: t(match[1] === "undo" ? "shortcuts.action.undo" : "shortcuts.action.redo"), count: match[2] });
	}

	if ((match = /^(.+) cannot be decoded in this browser\. Convert it to H\.264 MP4( or try importing it in Safari)?\.$/.exec(detail))) {
		const codec = match[1] === "The video codec" ? t("media.videoCodec") : match[1];
		return match[2]
			? t("media.codecUnsupportedSafari", { codec })
			: t("media.codecUnsupported", { codec });
	}

	if ((match = /^media no longer in the project: (.+); nothing was applied$/.exec(detail))) {
		return t("agentToast.mediaGone", { ids: match[1] });
	}
	if ((match = /^the draft is for project (.+), not the open one; nothing was applied$/.exec(detail))) {
		return t("agentToast.wrongProject", { id: match[1] });
	}

	if ((match = /^Preview and export are unavailable\. Retry graphics initialization\.(?: ([\s\S]+))?$/.exec(detail))) {
		return [t("export.graphicsUnavailable"), match[1] ? localizeErrorDetail(match[1], t) : null].filter(Boolean).join(" ");
	}
	if ((match = /^Scene not found: (.+)$/.exec(detail))) {
		return t("timeline.sceneIdNotFound", { id: match[1] });
	}
	if ((match = /^Compound scene not found: (.+)$/.exec(detail))) {
		return t("timeline.compoundSceneIdNotFound", { id: match[1] });
	}
	if ((match = /^Compound clip cycle: scene (.+) would contain itself \(directly or through nested compound clips\)$/.exec(detail))) {
		return t("timeline.compoundCycle", { id: match[1] });
	}

	return detail;
}

export function getDraftRejectionDescription({
	error,
	stale,
	cleanupFailed,
}: {
	error: string;
	stale: boolean;
	cleanupFailed: boolean;
}, t: ReturnType<typeof createTranslator>): string {
	return [
		localizeErrorDetail(error, t),
		stale ? t("agentToast.retryDraft") : null,
		t("agentToast.draftDetails"),
		cleanupFailed ? t("agentToast.cleanupFailed") : null,
	].filter(Boolean).join(" ");
}
