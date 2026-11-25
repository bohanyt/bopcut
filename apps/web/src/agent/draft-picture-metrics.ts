export const pictureWidth = 96, pictureHeight = 54;
export const pictureBytes = pictureWidth * pictureHeight * 3;
export const sampleFractions = [0.15, 0.5, 0.85];
const crops = [[1, 0, 0], [0.94, 0, 0], [0.91, 0, 0], [0.91, -0.019, 0.019],
	[0.91, 0.019, -0.019], [0.91, -0.019, -0.019], [0.91, 0.019, 0.019]];

export type PictureFrame = { at: number; duration: number; rgb: Uint8Array };
type Feature = Float32Array[];

/** Average a 3 × 3 grid within each coarse RGB cell, after a small crop and translation. */
export function pictureFeature(rgb: Uint8Array): Feature {
	return crops.map(([scale, dx, dy]) => {
		const result = new Float32Array(12 * 8 * 3);
		for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
			const p = (y * 12 + x) * 3;
			for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
				const ix = Math.floor((((x + (sx + 0.5) / 3) / 12 - 0.5) * scale + 0.5 + dx) * pictureWidth);
				const iy = Math.floor((((y + (sy + 0.5) / 3) / 8 - 0.5) * scale + 0.5 + dy) * pictureHeight);
				const i = (iy * pictureWidth + ix) * 3;
				for (let c = 0; c < 3; c++) result[p + c] += rgb[i + c] / 9;
			}
		}
		return result;
	});
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

export function pictureMatch(a: Feature[], b: Feature[], threshold: number) {
	const indices: number[] = [];
	let total = 0;
	for (let i = 0; i < sampleFractions.length; i++) {
		let distance = rms(a[i][0], b[i][0], threshold);
		for (let crop = 1; crop < crops.length; crop++) {
			distance = Math.min(distance, rms(a[i][crop], b[i][0], Math.min(threshold, distance)),
				rms(a[i][0], b[i][crop], Math.min(threshold, distance)));
		}
		if (distance <= threshold) { indices.push(i); total += distance; }
		if (i === 1 && !indices.length) return;
	}
	if (indices.length >= 2) return { matches: indices.length, rms: total / indices.length,
		evidenceIndex: indices.includes(1) ? 1 : indices[0] };
}

const freezeTolerance = 0.007;
const nearbyTolerance = 0.015;
const contiguous = (a: PictureFrame, b: PictureFrame) =>
	b.at > a.at && a.duration > 0 && b.at - a.at <= a.duration + 0.002;

export type PictureEvent = {
	kind: "frozen-stretch" | "single-frame-outlier"; from: number; to: number;
	frames: number; distance: number; frame: PictureFrame;
};

/** Scan true neighbours within one decoded window, never across a seek or a clip edge. */
export function pictureEvents(frames: PictureFrame[], freezeSeconds: number, outlierDistance: number) {
	const findings: PictureEvent[] = [];
	for (let i = 1; i + 1 < frames.length; i++) {
		const previous = frames[i - 1], frame = frames[i], next = frames[i + 1];
		if (!contiguous(previous, frame) || !contiguous(frame, next)) continue;
		if (rms(previous.rgb, next.rgb, nearbyTolerance) <= nearbyTolerance) {
			const distance = Math.min(rms(previous.rgb, frame.rgb), rms(frame.rgb, next.rgb));
			if (distance >= outlierDistance) findings.push({ kind: "single-frame-outlier", from: frame.at, to: next.at, frames: 1, distance, frame });
		}
		if (rms(previous.rgb, frame.rgb, nearbyTolerance) <= nearbyTolerance) continue;
		let end = i, distance = 0;
		while (end + 1 < frames.length && contiguous(frames[end], frames[end + 1])) {
			const difference = rms(frame.rgb, frames[end + 1].rgb, freezeTolerance);
			if (difference > freezeTolerance) break;
			distance = Math.max(distance, difference);
			end++;
		}
		const after = frames[end + 1];
		if (end - i >= 2 && after && contiguous(frames[end], after) &&
			after.at - frame.at >= freezeSeconds && rms(frame.rgb, after.rgb, nearbyTolerance) > nearbyTolerance) {
			findings.push({ kind: "frozen-stretch", from: frame.at, to: after.at, frames: end - i + 1, distance, frame });
			i = end;
		}
	}
	return findings;
}
