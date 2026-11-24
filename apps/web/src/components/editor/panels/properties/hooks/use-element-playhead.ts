import { useEditor } from "@/editor/use-editor";
import { getElementLocalTime } from "@/animation";
import { addMediaTime, mediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export function useElementPlayhead({
	startTime,
	duration,
	hasKeyframes,
	keyframable = true,
}: {
	startTime: MediaTime;
	duration: MediaTime;
	hasKeyframes: boolean;
	keyframable?: boolean;
}) {
	const editor = useEditor();
	const endTime = addMediaTime({ a: startTime, b: duration });
	const toLocalTime = (time: MediaTime) =>
		mediaTime({
			ticks: getElementLocalTime({
				timelineTime: time,
				elementStartTime: startTime,
				elementDuration: duration,
			}),
		});
	const [localTime, isPlayheadWithinElementRange] = useEditor((editor) => {
		if (!keyframable && !hasKeyframes) return [ZERO_MEDIA_TIME, false] as const;
		const time = editor.playback.getCurrentTime();
		return [hasKeyframes ? toLocalTime(time) : ZERO_MEDIA_TIME, time >= startTime && time <= endTime] as const;
	});

	return {
		localTime,
		isPlayheadWithinElementRange,
		getLocalTime: () => toLocalTime(editor.playback.getCurrentTime()),
	};
}
