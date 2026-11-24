import { expect, test } from "bun:test";
import { buildSourceWaveformSummary } from "@/media/waveform-summary";
import { waveformPeaks, WAVEFORM_BUCKET_SIZE } from "./peaks";

test("whole-bucket batches produce the original waveform summary", () => {
	const length = 4 * WAVEFORM_BUCKET_SIZE + 1;
	const left = new Float32Array(length);
	const right = new Float32Array(length);
	left[127] = -0.75;
	right[128] = 0.25;
	right[255] = -0.9;
	left[256] = Number.NaN;
	right[380] = 0.6;
	left[length - 1] = -1.2;

	const channels = [left, right];
	const full = buildSourceWaveformSummary({
		sourceKey: "test",
		buffer: { length, numberOfChannels: 2, sampleRate: 48_000, getChannelData: (channel: number) => channels[channel] } as AudioBuffer,
	});
	const boundary = 2 * WAVEFORM_BUCKET_SIZE;
	const part = (from: number, to: number) =>
		waveformPeaks(channels.map((samples) => samples.subarray(from, to)), to - from);
	expect([...part(0, boundary), ...part(boundary, length)]).toEqual([...full.amplitudes]);
});
