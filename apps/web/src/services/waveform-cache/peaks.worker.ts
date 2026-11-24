import { waveformPeaks } from "./peaks";

self.onmessage = ({ data }: MessageEvent<{ channels: Float32Array[]; length: number }>) => {
	const peaks = waveformPeaks(data.channels, data.length);
	self.postMessage(peaks, { transfer: [peaks.buffer] });
};
