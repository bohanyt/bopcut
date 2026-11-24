import type { StaticMessageKey } from "@/i18n/translate";

export type MicrophoneOptions = { deviceId: string; noiseSuppression: boolean };

type WorkletMessage =
	| { type: "level"; peak: number }
	| { type: "started"; frame: number }
	| { type: "samples"; samples: Int16Array<ArrayBuffer> }
	| { type: "stopped" };

export class Microphone {
	readonly sampleRate: number;
	readonly inputLatency: number;
	readonly outputLatency: number;
	readonly deviceId: string;
	private chunks: Int16Array<ArrayBuffer>[] = [];
	private onStart?: (frame: number) => void;
	private onStop?: () => void;
	private closed = false;

	private constructor(
		private context: AudioContext,
		private stream: MediaStream,
		private source: MediaStreamAudioSourceNode,
		private node: AudioWorkletNode,
		onLevel: (peak: number) => void,
		onLost: () => void,
	) {
		const settings = stream.getAudioTracks()[0].getSettings();
		const { latency } = settings as MediaTrackSettings & { latency?: number };
		this.inputLatency = Number.isFinite(latency) ? Math.max(0, latency ?? 0) : 0;
		this.outputLatency = (context.baseLatency || 0) + (context.outputLatency || 0);
		this.deviceId = settings.deviceId ?? "";
		this.sampleRate = context.sampleRate;
		stream.getAudioTracks()[0].addEventListener("ended", onLost, { once: true });
		node.addEventListener("processorerror", onLost, { once: true });
		node.port.onmessage = ({ data }: MessageEvent<WorkletMessage>) => {
			if (data.type === "level") onLevel(data.peak);
			else if (data.type === "samples") this.chunks.push(data.samples);
			else if (data.type === "started") this.onStart?.(data.frame);
			else this.onStop?.();
		};
	}

	static async open(
		{ deviceId, noiseSuppression }: MicrophoneOptions,
		signal: AbortSignal,
		onLevel: (peak: number) => void,
		onLost: () => void,
	): Promise<Microphone> {
		if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
			throw new DOMException("Microphone capture unavailable", "NotSupportedError");
		}
		const context = new AudioContext({ latencyHint: "interactive" });
		let stream: MediaStream | undefined;
		const cleanup = () => {
			stream?.getTracks().forEach((track) => track.stop());
			if (context.state !== "closed") void context.close().catch(() => {});
		};
		signal.addEventListener("abort", cleanup, { once: true });

		try {
			// Resume during the opening gesture. Some devices only report labels after permission.
			const resume = context.resume();
			void resume.catch(() => {});
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					...(deviceId ? { deviceId: { exact: deviceId } } : {}),
					channelCount: 1,
					echoCancellation: false,
					autoGainControl: false,
					noiseSuppression,
				},
			});
			signal.throwIfAborted();
			if (!context.audioWorklet) throw new DOMException("Audio worklet unavailable", "NotSupportedError");
			await Promise.all([context.audioWorklet.addModule("/worklets/voice-over.js"), resume]);
			signal.throwIfAborted();
			const source = context.createMediaStreamSource(stream);
			const node = new AudioWorkletNode(context, "voice-over", {
				channelCount: 1,
				channelCountMode: "explicit",
				outputChannelCount: [1],
			});
			const mic = new Microphone(context, stream, source, node, onLevel, onLost);
			source.connect(node).connect(context.destination);
			return mic;
		} catch (error) {
			cleanup();
			throw error;
		} finally {
			signal.removeEventListener("abort", cleanup);
		}
	}

	getTime(): number {
		return this.context.currentTime;
	}

	start(onStart: (frame: number) => void): void {
		this.onStart = onStart;
		this.node.port.postMessage("start");
	}

	async stop(): Promise<Int16Array<ArrayBuffer>[]> {
		this.onStart = undefined;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(resolve, 500);
			this.onStop = () => {
				clearTimeout(timeout);
				resolve();
			};
			try {
				this.node.port.postMessage("stop");
			} catch {
				this.onStop();
			}
		});
		this.close();
		const chunks = this.chunks;
		this.chunks = [];
		return chunks;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onStop?.();
		this.stream.getTracks().forEach((track) => track.stop());
		this.source.disconnect();
		this.node.disconnect();
		this.node.port.close();
		void this.context.close().catch(() => {});
	}
}

export type MicrophoneInput = Pick<Microphone, keyof Microphone>;
export type OpenMicrophone = (...args: Parameters<typeof Microphone.open>) => Promise<MicrophoneInput>;

export function microphoneError(error: unknown): StaticMessageKey & `recording.${string}` {
	const name = error instanceof Error ? error.name : "";
	switch (name) {
		case "NotAllowedError":
		case "SecurityError": return "recording.permissionDenied";
		case "NotFoundError":
		case "OverconstrainedError": return "recording.noMicrophone";
		case "NotReadableError":
		case "AbortError": return "recording.microphoneBusy";
		case "NotSupportedError": return "recording.unavailable";
		default: return "recording.microphoneFailed";
	}
}
