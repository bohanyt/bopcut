import {
	applyEffectPasses,
	applyMaskFeather as applyMaskFeatherWasm,
} from "opencut-wasm";
import type { EffectPass, EffectUniformValue } from "@/effects/types";
import { checkGraphicsContext, rendererDevice, rethrowGraphicsFailure } from "./renderer-device";

export const gpuRenderer = {
	applyEffect({
		source,
		width,
		height,
		passes,
	}: {
		source: OffscreenCanvas;
		width: number;
		height: number;
		passes: EffectPass[];
	}): OffscreenCanvas {
		if (passes.length === 0 || rendererDevice.status.state !== "ready") {
			return source;
		}

		try {
			checkGraphicsContext();
			return applyEffectPasses({
				source,
				width,
				height,
				passes: serializeEffectPasses(passes),
			});
		} catch (error) {
			rethrowGraphicsFailure(error);
		}
	},

	applyMaskFeather({
		maskCanvas,
		width,
		height,
		feather,
	}: {
		maskCanvas: OffscreenCanvas;
		width: number;
		height: number;
		feather: number;
	}): OffscreenCanvas {
		checkGraphicsContext();
		return applyMaskFeatherWasm({
			mask: maskCanvas,
			width,
			height,
			feather,
		});
	},
};

function serializeEffectPasses(passes: EffectPass[]) {
	return passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.entries(pass.uniforms).map(([name, value]) => ({
			name,
			value: normalizeUniformValue(value),
		})),
	}));
}

function normalizeUniformValue(value: EffectUniformValue): number[] {
	return typeof value === "number" ? [value] : value;
}
