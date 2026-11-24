import { afterEach, expect, mock, test } from "bun:test";
import { Microphone } from "./microphone";

const original = {
	AudioContext: globalThis.AudioContext,
	AudioWorkletNode: globalThis.AudioWorkletNode,
	mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
};

afterEach(() => {
	Object.assign(globalThis, { AudioContext: original.AudioContext, AudioWorkletNode: original.AudioWorkletNode });
	if (original.mediaDevices) Object.defineProperty(navigator, "mediaDevices", original.mediaDevices);
	else Reflect.deleteProperty(navigator, "mediaDevices");
});

async function open() {
	const port = { onmessage: (_event: { data: unknown }) => {}, postMessage: mock((_data: unknown) => {}), close: mock(() => {}) };
	const stopTrack = mock(() => {});
	const track = { getSettings: () => ({}), addEventListener: () => {}, stop: stopTrack };
	const graph = { connect: (node: unknown) => node, disconnect: () => {} };
	Object.assign(globalThis, {
		AudioContext: class {
			sampleRate = 48000;
			state = "running";
			audioWorklet = { addModule: async () => {} };
			resume = async () => {};
			close = async () => {};
			createMediaStreamSource = () => graph;
		},
		AudioWorkletNode: class {
			port = port;
			connect = graph.connect;
			disconnect = graph.disconnect;
			addEventListener = () => {};
		},
	});
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) },
	});
	const mic = await Microphone.open(
		{ deviceId: "", noiseSuppression: false }, new AbortController().signal, () => {}, () => {},
	);
	const send = (data: unknown) => port.onmessage({ data });
	const samples = (length: number) => send({ type: "samples", samples: new Int16Array(length) });
	return { mic, send, samples, stopTrack };
}

test("stop keeps samples and the acknowledgment that arrive after a stalled main thread", async () => {
	const { mic, send, samples, stopTrack } = await open();
	samples(100);
	const stopped = mic.stop({ quietMs: 80 });
	// The stall expires the first check before the queued messages are handled.
	const until = performance.now() + 200;
	while (performance.now() < until);
	setTimeout(() => {
		samples(50);
		send({ type: "stopped", frames: 150 });
	}, 0);
	const { chunks, complete } = await stopped;
	expect(chunks.map(({ length }) => length)).toEqual([100, 50]);
	expect(complete).toBe(true);
	expect(stopTrack).toHaveBeenCalled();
});

test("stop reports an incomplete take when samples are missing or the worklet never answers", async () => {
	const missing = await open();
	missing.samples(100);
	const stopped = missing.mic.stop({ quietMs: 80 });
	missing.send({ type: "stopped", frames: 150 });
	expect((await stopped).complete).toBe(false);

	const silent = await open();
	silent.samples(100);
	const { chunks, complete } = await silent.mic.stop({ quietMs: 80 });
	expect(chunks.length).toBe(1);
	expect(complete).toBe(false);
	expect(silent.stopTrack).toHaveBeenCalled();
});
