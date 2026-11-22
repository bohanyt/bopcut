/** Web Audio PCM storage for tests running without a browser. */
export class TestAudioBuffer implements AudioBuffer {
	readonly numberOfChannels: number;
	readonly length: number;
	readonly sampleRate: number;
	private channels: Float32Array<ArrayBuffer>[];

	constructor({ numberOfChannels = 1, length, sampleRate }: AudioBufferOptions) {
		this.numberOfChannels = numberOfChannels;
		this.length = length;
		this.sampleRate = sampleRate;
		const channelBytes = length * Float32Array.BYTES_PER_ELEMENT;
		const storage = new ArrayBuffer(numberOfChannels * channelBytes);
		this.channels = [];
		for (let channel = 0; channel < numberOfChannels; channel++) {
			this.channels.push(new Float32Array(storage, channel * channelBytes, length));
		}
	}

	get duration() { return this.length / this.sampleRate; }
	getChannelData(channel: number) { return this.channels[channel]; }
	copyFromChannel(target: Float32Array, channel: number, start = 0) {
		target.set(this.channels[channel].subarray(start, start + target.length));
	}
	copyToChannel(source: Float32Array, channel: number, start = 0) {
		this.channels[channel].set(source.subarray(0, this.length - start), start);
	}
}
