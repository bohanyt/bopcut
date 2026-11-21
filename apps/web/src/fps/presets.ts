import type { FrameRate } from "opencut-wasm";
import { frameRateToFloat } from "./utils";

export const FPS_PRESETS = [
	{ value: "24", label: "24 fps" },
	{ value: "25", label: "25 fps" },
	{ value: "30", label: "30 fps" },
	{ value: "60", label: "60 fps" },
	{ value: "120", label: "120 fps" },
] as const;

export function getCurrentFpsOption(fps: FrameRate) {
	const rate = frameRateToFloat(fps);
	const preset = FPS_PRESETS.find(({ value }) => Number(value) === rate);
	if (preset) return preset;
	const value = `${fps.numerator}/${fps.denominator}`;
	const rounded = Number(rate.toFixed(3));
	const label = Number.isInteger(rounded) && rounded !== rate ? value : rounded;
	return { value, label: `${label} fps` };
}
