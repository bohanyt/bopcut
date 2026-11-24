class VoiceOverProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.recording = false;
		this.pendingStart = false;
		this.chunk = new Int16Array(4096);
		this.used = 0;
		this.peak = 0;
		this.nextMeterFrame = 0;
		this.port.onmessage = ({ data }) => {
			if (data === "start") this.pendingStart = true;
			if (data === "stop") {
				this.recording = false;
				this.pendingStart = false;
				this.flush();
				this.port.postMessage({ type: "stopped" });
			}
		};
	}

	flush() {
		if (!this.used) return;
		const samples = this.used === this.chunk.length ? this.chunk : this.chunk.slice(0, this.used);
		this.port.postMessage({ type: "samples", samples }, [samples.buffer]);
		this.chunk = new Int16Array(4096);
		this.used = 0;
	}

	process(inputs, outputs) {
		const input = inputs[0]?.[0];
		if (this.pendingStart && input?.length) {
			this.pendingStart = false;
			this.recording = true;
			this.port.postMessage({ type: "started", frame: currentFrame });
		}
		const frames = outputs[0][0].length;
		for (let i = 0; i < frames; i++) {
			const value = input?.[i] ?? 0;
			this.peak = Math.max(this.peak, Math.abs(value));
			if (this.recording) {
				const clamped = Math.max(-1, Math.min(1, value));
				this.chunk[this.used++] = Math.round(clamped * (clamped < 0 ? 32768 : 32767));
				if (this.used === this.chunk.length) this.flush();
			}
		}
		if (currentFrame >= this.nextMeterFrame) {
			this.port.postMessage({ type: "level", peak: this.peak });
			this.peak = 0;
			this.nextMeterFrame = currentFrame + sampleRate / 20;
		}
		// The output stays zero so the graph can run without monitoring the microphone.
		return true;
	}
}

registerProcessor("voice-over", VoiceOverProcessor);
