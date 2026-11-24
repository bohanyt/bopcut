import { expect, test } from "bun:test";
import { pointInRotatedRect } from "./hit-test";

const cx = 400;
const cy = 300;
const height = 100;
const halfH = height / 2;

function worldFromLocal(
	localX: number,
	localY: number,
	rotationDeg: number,
): [number, number] {
	const angleRad = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	return [
		cx + localX * cos - localY * sin,
		cy + localX * sin + localY * cos,
	];
}

function outsideAlongDiagonal(
	cornerX: number,
	cornerY: number,
	epsilon: number,
): [number, number] {
	const dx = cornerX - cx;
	const dy = cornerY - cy;
	const len = Math.hypot(dx, dy);
	return [
		cornerX + (dx / len) * epsilon,
		cornerY + (dy / len) * epsilon,
	];
}

const localCorners: [number, number][] = [
	[-1, -1],
	[1, -1],
	[1, 1],
	[-1, 1],
];

for (const rotation of [359, 45, 0.1]) {
	for (const width of [200, -200]) {
		const halfW = Math.abs(width) / 2;
		test(`corner hit tolerance rotation=${rotation} width=${width}`, () => {
			for (const [sx, sy] of localCorners) {
				const localX = sx * halfW;
				const localY = sy * halfH;
				const [px, py] = worldFromLocal(localX, localY, rotation);
				expect(
					pointInRotatedRect({
						px,
						py,
						cx,
						cy,
						width,
						height,
						rotation,
					}),
				).toBe(true);

				const [ox, oy] = outsideAlongDiagonal(px, py, 0.01);
				expect(
					pointInRotatedRect({
						px: ox,
						py: oy,
						cx,
						cy,
						width,
						height,
						rotation,
					}),
				).toBe(false);
			}
		});
	}
}