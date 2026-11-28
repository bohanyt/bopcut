import { MAX_PLAYBACK_RATE } from "@/core/managers/playback-manager";

/**
 * The speed after a shuttle key (L forwards, J backwards): from a stop or the other direction it
 * starts at 1× that way; pressed again while playing that way, it doubles, up to the fastest.
 */
export function nextShuttleRate({ playing, rate, direction }: { playing: boolean; rate: number; direction: 1 | -1 }): number {
	if (!playing || Math.sign(rate) !== direction) return direction;
	return direction * Math.min(MAX_PLAYBACK_RATE, Math.abs(rate) * 2);
}

/** The speed as shown briefly while it changes: "2×", "−1×". */
export const shuttleLabel = (rate: number) => `${rate < 0 ? "−" : ""}${Math.abs(rate)}×`;
