export const pictureWidth = 96, pictureHeight = 54;
export const pictureBytes = pictureWidth * pictureHeight * 3;
export const sampleFractions = [0.15, 0.5, 0.85];
const crops = [[1, 0, 0], [0.94, 0, 0], [0.91, 0, 0], [0.91, -0.019, 0.019],
	[0.91, 0.019, -0.019], [0.91, -0.019, -0.019], [0.91, 0.019, 0.019]];

export type PictureFrame = { at: number; rgb: Uint8Array };
type Variant = { coarse: Float32Array; detail: Float32Array };
type Feature = { variants: Variant[]; informative: boolean };

/** Average a 3 × 3 grid within each coarse RGB cell, after a small crop and translation. */
export function pictureFeature(rgb: Uint8Array): Feature {
	const variants = crops.map(([scale, dx, dy]) => {
		const coarse = new Float32Array(12 * 8 * 3);
		const detail = new Float32Array(12 * 8 * 9);
		for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
			const p = (y * 12 + x) * 3;
			for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
				const ix = Math.floor((((x + (sx + 0.5) / 3) / 12 - 0.5) * scale + 0.5 + dx) * pictureWidth);
				const iy = Math.floor((((y + (sy + 0.5) / 3) / 8 - 0.5) * scale + 0.5 + dy) * pictureHeight);
				const i = (iy * pictureWidth + ix) * 3;
				for (let c = 0; c < 3; c++) coarse[p + c] += rgb[i + c] / 9;
				detail[p * 3 + sy * 3 + sx] = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
			}
		}
		return { coarse, detail };
	});
	const detail = variants[0].detail;
	const mean = detail.reduce((sum, value) => sum + value, 0) / detail.length;
	const deviation = Math.sqrt(detail.reduce((sum, value) => sum + (value - mean) ** 2, 0) / detail.length);
	return { variants, informative: mean >= 12 && deviation >= 7 };
}

function rms(a: ArrayLike<number>, b: ArrayLike<number>, limit = Infinity) {
	let squared = 0;
	const max = (255 * limit) ** 2 * a.length;
	for (let i = 0; i < a.length; i++) {
		squared += (a[i] - b[i]) ** 2;
		if (squared > max) return Infinity;
	}
	return Math.sqrt(squared / a.length) / 255;
}

function alignedDistance(a: Variant, b: Variant, threshold: number, detailLimit: number) {
	const distance = rms(a.coarse, b.coarse, threshold);
	if (!Number.isFinite(distance)) return Infinity;
	// A different glyph or small object can occupy too little of the frame to change global RMS.
	const localLimit = (255 * detailLimit) ** 2 * 9;
	for (let i = 0; i < a.detail.length; i += 9) {
		let local = 0;
		for (let j = i; j < i + 9; j++) local += (a.detail[j] - b.detail[j]) ** 2;
		if (local > localLimit) return Infinity;
	}
	return distance;
}

export function pictureMatch(a: Feature[], b: Feature[], threshold: number) {
	const indices: number[] = [];
	let total = 0;
	const detailLimit = Math.min(0.25, threshold * 5);
	for (let i = 0; i < sampleFractions.length; i++) {
		if (a[i].informative && b[i].informative) {
			const left = a[i].variants, right = b[i].variants;
			let distance = alignedDistance(left[0], right[0], threshold, detailLimit);
			for (let crop = 1; crop < crops.length; crop++) {
				distance = Math.min(distance, alignedDistance(left[crop], right[0], Math.min(threshold, distance), detailLimit),
					alignedDistance(left[0], right[crop], Math.min(threshold, distance), detailLimit));
			}
			if (distance <= threshold) { indices.push(i); total += distance; }
		}
		if (i === 1 && !indices.length) return;
	}
	if (indices.length >= 2) return { matches: indices.length, rms: total / indices.length,
		evidenceIndex: indices.includes(1) ? 1 : indices[0] };
}

/** Use the decoded presentation times, including a frame carried in from before the window. */
export function activePictureFrame(frames: PictureFrame[], at: number, end: number, capped = false) {
	if (at >= end) return;
	const index = frames.findLastIndex(frame => frame.at <= at + 1e-9);
	if (index < 0 || (capped && index === frames.length - 1 && at > frames[index].at + 1e-9)) return;
	return frames[index];
}

export type PictureEvent = {
	kind: "frozen-stretch" | "single-frame-outlier"; from: number; to: number;
	frames: number; distance: number; frame: PictureFrame;
};

/** Scan true neighbours within one decoded window, never across a seek or a clip edge. */
export function pictureEvents(frames: PictureFrame[], freezeSeconds: number, outlierDistance: number) {
	const findings: PictureEvent[] = [];
	const changes = frames.slice(1).map((frame, i) => rms(frames[i].rgb, frame.rgb));
	const motion = changes.filter(change => change >= 0.004).sort((a, b) => a - b);
	const typical = motion[Math.floor(motion.length / 2)] ?? 0;
	const freezeTolerance = Math.min(0.007, typical * 0.33);
	const moving = (change: number) => change >= Math.max(0.004, typical * 0.4) && change <= Math.min(0.2, typical * 3);
	const approaches = (index: number) => index >= 0 && index + 3 <= changes.length && changes.slice(index, index + 3).every(moving);
	for (let i = 1; i + 1 < frames.length; i++) {
		const previous = frames[i - 1], frame = frames[i], next = frames[i + 1];
		const distance = Math.min(changes[i - 1], changes[i]);
		if (distance >= outlierDistance && rms(previous.rgb, next.rgb, 0.015) <= 0.015) {
			findings.push({ kind: "single-frame-outlier", from: frame.at, to: next.at, frames: 1, distance, frame });
		}
		if (!approaches(i - 3)) continue;
		let end = i, stillness = 0;
		while (end + 1 < frames.length) {
			const difference = rms(frame.rgb, frames[end + 1].rgb, freezeTolerance);
			if (difference > freezeTolerance) break;
			stillness = Math.max(stillness, difference);
			end++;
		}
		const after = frames[end + 1];
		if (end - i >= 2 && after && approaches(end) && after.at - frame.at >= freezeSeconds) {
			findings.push({ kind: "frozen-stretch", from: frame.at, to: after.at, frames: end - i + 1, distance: stillness, frame });
			i = end;
		}
	}
	return findings;
}
