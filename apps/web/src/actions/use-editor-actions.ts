"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { getBrowserTranslator } from "@/i18n/browser";

import { useEffect, useState } from "react";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useActionHandler } from "@/actions/use-action-handler";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	minMediaTime,
	roundFrameTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { getElementsAtTime, hasMediaId } from "@/timeline";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { canToggleSourceAudio } from "@/timeline/audio-separation";
import {
	activateScope,
	clearActiveScope,
	type ScopeEntry,
} from "@/selection/scope";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { toggleSelectedKeyframeLanes } from "@/timeline/keyframe-lanes";
import { isCompoundElement } from "@/timeline/compound";
import { elementsBesidePlayhead } from "@/timeline/beside-playhead";
import { toast } from "sonner";
import { nextShuttleRate, shuttleLabel } from "./shuttle";
import { planPasteAttributes } from "@/clipboard/paste-attributes";

export function useEditorActions() {
	const editor = useEditor();
	const { selectedElements, setElementSelection } = useElementSelection();
	const { selectedKeyframes } = useKeyframeSelection();
	const selectedMaskPointSelection = useEditor((e) =>
		e.selection.getSelectedMaskPointSelection(),
	);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);
	const hasTimelineSelection =
		selectedElements.length > 0 ||
		selectedKeyframes.length > 0 ||
		selectedMaskPointSelection !== null;
	const hasTimelineSelectionRef = useCommittedRef(hasTimelineSelection);
	const clearTimelineSelectionRef = useCommittedRef(() => {
		editor.selection.clearSelection();
	});
	const clearTimelineActiveSelectionRef = useCommittedRef(() => {
		editor.selection.clearMostSpecificSelection();
	});
	const [timelineScope] = useState<ScopeEntry>(() => ({
		hasSelection: () => hasTimelineSelectionRef.current,
		clear: () => {
			clearTimelineSelectionRef.current();
		},
		clearActive: () => {
			clearTimelineActiveSelectionRef.current();
		},
	}));

	useEffect(() => {
		if (!hasTimelineSelection) {
			return;
		}

		return activateScope({ entry: timelineScope });
	}, [hasTimelineSelection, timelineScope]);

	// Keyboard moves land on the project's frame grid: whole seconds are not whole frames at
	// 29.97 fps, and a split at the playhead must stay on a frame. The end of the timeline stays reachable.
	const navigate = ({ time }: { time: MediaTime }) => {
		const end = editor.timeline.getTotalDuration();
		const onGrid = roundFrameTime({ time, fps: editor.project.getActive().settings.fps });
		editor.playback.seek({ time: time >= end ? end : minMediaTime({ a: end, b: maxMediaTime({ a: ZERO_MEDIA_TIME, b: onGrid }) }) });
		editor.playback.revealPlayhead();
	};

	useActionHandler("record-voice-over", () => editor.voiceOver.toggle(), undefined);

	useActionHandler(
		"toggle-play",
		() => {
			if (editor.voiceOver.isCapturing()) void editor.voiceOver.stop();
			else editor.playback.toggle();
		},
		undefined,
	);

	const shuttle = (direction: 1 | -1) => {
		if (editor.voiceOver.isCapturing()) return;
		const { playback } = editor;
		playback.setRate(nextShuttleRate({ playing: playback.getIsPlaying(), rate: playback.getRate(), direction }));
		if (!playback.getIsPlaying()) playback.play();
		if (playback.getIsPlaying()) toast(shuttleLabel(playback.getRate()), { id: "shuttle-rate", duration: 900 });
	};
	useActionHandler("shuttle-forward", () => shuttle(1), undefined);
	useActionHandler("shuttle-backward", () => shuttle(-1), undefined);
	useActionHandler(
		"shuttle-stop",
		() => {
			if (editor.voiceOver.isCapturing()) void editor.voiceOver.stop();
			else editor.playback.pause();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.toggle();
			}
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			navigate({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			navigate({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			navigate({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			navigate({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			navigate({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			navigate({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			navigate({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			navigate({ time: editor.timeline.getTotalDuration() });
		},
		undefined,
	);

	useActionHandler(
		"split",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const elements = getElementsAtTime({
				tracks: editor.scenes.getActiveScene().tracks,
				time: currentTime,
			});
			if (elements.length === 0) return;

			editor.timeline.splitElements({
				elements,
				splitTime: currentTime,
				selected: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"split-selected",
		() => {
			if (selectedElements.length === 0) return;

			editor.timeline.splitElements({
				elements: selectedElements,
				splitTime: editor.playback.getCurrentTime(),
			});
		},
		undefined,
	);

	useActionHandler(
		"split-left",
		() => {
			if (selectedElements.length === 0) return;

			const rightSideElements = editor.timeline.splitElements({
				elements: selectedElements,
				splitTime: editor.playback.getCurrentTime(),
				retainSide: "right",
			});

			if (rippleEditingEnabled && rightSideElements.length > 0) {
				const firstRightElement = editor.timeline.getElementsWithTracks({
					elements: [rightSideElements[0]],
				})[0];
				if (firstRightElement) {
					editor.playback.seek({ time: firstRightElement.element.startTime });
				}
			}
		},
		undefined,
	);

	useActionHandler(
		"split-right",
		() => {
			if (selectedElements.length === 0) return;

			editor.timeline.splitElements({
				elements: selectedElements,
				splitTime: editor.playback.getCurrentTime(),
				retainSide: "left",
			});
		},
		undefined,
	);

	useActionHandler(
		"delete-selected",
		() => {
			switch (editor.selection.getActiveSelectionKind()) {
				case "mask-points":
					if (!selectedMaskPointSelection) {
						return;
					}
					editor.timeline.deleteFreeformPathMaskPoints({
						trackId: selectedMaskPointSelection.trackId,
						elementId: selectedMaskPointSelection.elementId,
						maskId: selectedMaskPointSelection.maskId,
						pointIds: selectedMaskPointSelection.pointIds,
					});
					return;
				case "keyframes":
					if (selectedKeyframes.length === 0) {
						return;
					}
					editor.timeline.removeKeyframes({ keyframes: selectedKeyframes, clearSelection: true });
					return;
				case "elements":
					if (selectedElements.length === 0) {
						return;
					}
					editor.timeline.deleteElements({
						elements: selectedElements,
					});
					return;
				default:
					return;
			}
		},
		undefined,
	);

	useActionHandler(
		"toggle-source-audio",
		() => {
			if (selectedElements.length !== 1) {
				return;
			}

			const selectedElement = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			})[0];
			if (!selectedElement) {
				return;
			}

			const mediaAsset = (() => {
				const { element } = selectedElement;
				if (!hasMediaId(element)) {
					return null;
				}

				return (
					editor.media
						.getAssets()
						.find((asset) => asset.id === element.mediaId) ?? null
				);
			})();
			if (!canToggleSourceAudio(selectedElement.element, mediaAsset)) {
				return;
			}

			editor.timeline.toggleSourceAudioSeparation({
				trackId: selectedElement.track.id,
				elementId: selectedElement.element.id,
			});
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const scene = editor.scenes.getActiveScene();
			const allElements = [
				...scene.tracks.overlay,
				scene.tracks.main,
				...scene.tracks.audio,
			].flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			setElementSelection({ elements: allElements });
		},
		undefined,
	);

	useActionHandler(
		"select-right-of-playhead",
		() => setElementSelection({ elements: elementsBesidePlayhead({ tracks: editor.scenes.getActiveScene().tracks, time: editor.playback.getCurrentTime(), side: "right" }) }),
		undefined,
	);

	// On the tracks of the clips selected now (Ctrl+Shift+click picks a whole track); with none, on every track.
	const besideOnSelectedTracks = (side: "left" | "right") => {
		const picked = new Set(editor.selection.getSelectedElements().map(({ trackId }) => trackId));
		setElementSelection({ elements: elementsBesidePlayhead({
			tracks: editor.scenes.getActiveScene().tracks, time: editor.playback.getCurrentTime(), side,
			...(picked.size && { onTracks: picked }),
		}) });
	};
	useActionHandler("select-right-on-selected-tracks", () => besideOnSelectedTracks("right"), undefined);
	useActionHandler("select-left-on-selected-tracks", () => besideOnSelectedTracks("left"), undefined);

	useActionHandler(
		"select-left-of-playhead",
		() => setElementSelection({ elements: elementsBesidePlayhead({ tracks: editor.scenes.getActiveScene().tracks, time: editor.playback.getCurrentTime(), side: "left" }) }),
		undefined,
	);

	useActionHandler(
		"cancel-interaction",
		() => {
			if (cancelInteraction()) return;
			// Esc clears the selection first; with nothing left to clear it leaves a compound clip.
			if (clearActiveScope() || editor.selection.clearMostSpecificSelection()) return;
			editor.scenes.exitCompound();
		},
		undefined,
	);

	useActionHandler(
		"deselect-all",
		() => {
			if (!clearActiveScope()) {
				editor.selection.clearMostSpecificSelection();
			}
		},
		undefined,
	);

	useActionHandler(
		"create-compound",
		() => {
			if (selectedElements.length === 0) return;
			try {
				editor.timeline.createCompound({ elements: selectedElements });
			} catch (error) {
				toast.error(
					error instanceof Error
						? localizeErrorDetail(error.message, getBrowserTranslator())
						: getBrowserTranslator()("timeline.createCompoundFailed"),
				);
			}
		},
		undefined,
	);

	useActionHandler(
		"break-apart-compound",
		() => {
			const compounds = editor.timeline
				.getElementsWithTracks({ elements: selectedElements })
				.filter(({ element }) => isCompoundElement(element));
			if (compounds.length !== 1) {
				if (compounds.length > 1) toast.error(getBrowserTranslator()("timeline.selectOneCompound"));
				return;
			}
			const [{ track, element }] = compounds;
			editor.timeline.ungroupCompound({ trackId: track.id, elementId: element.id });
		},
		undefined,
	);

	useActionHandler(
		"exit-compound",
		() => {
			editor.scenes.exitCompound();
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateElements({
				elements: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-muted-selected",
		() => {
			editor.timeline.toggleElementsMuted({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-visibility-selected",
		() => {
			editor.timeline.toggleElementsVisibility({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-bookmark",
		() => {
			editor.scenes.toggleBookmark({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			editor.clipboard.copy();
		},
		undefined,
	);

	useActionHandler(
		"cut-selected",
		() => {
			// Copy, then remove as Delete does (a gap, no ripple): only the removal is an Undo step.
			if (editor.selection.getActiveSelectionKind() !== "elements" || selectedElements.length === 0) return;
			if (!editor.clipboard.copy()) return;
			editor.timeline.deleteElements({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"paste-attributes",
		() => {
			const t = getBrowserTranslator();
			const entry = editor.clipboard.getEntry();
			const source = entry?.type === "elements" ? entry.items[0]?.element : undefined;
			if (!source) {
				toast.error(t("clipboard.attributesNoSource"));
				return;
			}
			const targets = editor.timeline.getElementsWithTracks({ elements: editor.selection.getSelectedElements() });
			const plan = planPasteAttributes({ source, targets });
			if (!plan.keys.length) {
				toast.info(t("clipboard.attributesNothing"));
				return;
			}
			editor.timeline.updateElements({ updates: plan.updates });
			toast.success(t("clipboard.attributesPasted", { updated: plan.updated.length, skipped: plan.skipped.length }), {
				description: plan.keys.join(", "),
			});
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			editor.clipboard.paste();
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"toggle-keyframe-lanes",
		() => {
			toggleSelectedKeyframeLanes(editor);
		},
		undefined,
	);

	useActionHandler(
		"toggle-ripple-editing",
		() => {
			toggleRippleEditing();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);

	// todo: potnetially unify these two actions:
	useActionHandler(
		"remove-media-asset",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAsset({
				projectId: args.projectId,
				id: args.assetId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-media-assets",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAssets({
				projectId: args.projectId,
				ids: args.assetIds,
			});
		},
		undefined,
	);
}
