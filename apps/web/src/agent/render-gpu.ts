const prefix = "graphics adapter: ";
const vendors = [
	["software", /\b(?:software|swiftshader|llvmpipe|warp)\b/i],
	["AMD", /\b(?:amd|ati|radeon)\b/i],
	["Apple", /\bapple\b/i],
	["ARM", /\b(?:arm|mali)\b/i],
	["Intel", /\bintel\b/i],
	["NVIDIA", /\bnvidia\b/i],
	["Qualcomm", /\b(?:qualcomm|adreno)\b/i],
] as const;

export const renderGpuWorkaround = "If graphics could not start, retry with BOPENCUT_RENDER_GPU=low-power.";

export function renderAdapterStage(description?: string) {
	const vendor = vendors.find(([, pattern]) => pattern.test(description ?? ""))?.[0] ?? "unknown";
	return `${prefix}${vendor}`;
}

export function isRenderAdapterStage(stage: unknown) {
	return stage === `${prefix}unknown` || vendors.some(([vendor]) => stage === `${prefix}${vendor}`);
}
