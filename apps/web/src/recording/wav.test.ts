import { expect, test } from "bun:test";
import { alignedStartFrame, trimPcmStart, wavParts } from "./wav";

test("encodes finite mono PCM with the capture rate and little-endian signed samples", async () => {
	const blob = new Blob(wavParts([Int16Array.of(-32768, 0), Int16Array.of(32767)], 44100));
	const buffer = await blob.arrayBuffer();
	const view = new DataView(buffer);
	expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe("RIFF");
	expect(view.getUint32(4, true)).toBe(42);
	expect(new TextDecoder().decode(buffer.slice(8, 12))).toBe("WAVE");
	expect(view.getUint16(20, true)).toBe(1);
	expect(view.getUint16(22, true)).toBe(1);
	expect(view.getUint32(24, true)).toBe(44100);
	expect(view.getUint32(28, true)).toBe(88200);
	expect(view.getUint16(34, true)).toBe(16);
	expect(view.getUint32(40, true)).toBe(6);
	expect([44, 46, 48].map((offset) => view.getInt16(offset, true))).toEqual([-32768, 0, 32767]);
});

test("aligns from the audio clock, compensates known latency and trims across chunks", () => {
	const firstFrame = 48_000;
	const frame = alignedStartFrame({ playbackTime: 1.030, sampleRate: 48000, inputLatency: .005, outputLatency: .010 });
	expect(frame - firstFrame).toBe(2160);
	const second = new Int16Array(2000);
	second[160] = 175;
	const trimmed = trimPcmStart([new Int16Array(2000), second], frame - firstFrame);
	expect(trimmed[0].length).toBe(1840);
	expect(trimmed[0][0]).toBe(175);
	expect(trimmed[0].buffer).toBe(second.buffer);
	expect(trimPcmStart([second], 2000)).toEqual([]);
	expect(alignedStartFrame({ playbackTime: 1, sampleRate: 48000 })).toBe(firstFrame);
});
