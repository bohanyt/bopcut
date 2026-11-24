import { expect, spyOn, test } from "bun:test";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";
import { CanvasRenderer } from "./canvas-renderer";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { RootNode } from "./nodes/root-node";
import * as graphics from "./renderer-device";
import { resolveRenderTree } from "./resolve";

registerDefaultEffects();

const fps = { numerator: 30, denominator: 1 };
const frame = 1 / 30;

test("effect layer is active on [start, end) only", async () => {
	const timeOffset = 1;
	const duration = 2;
	const definition = effectsRegistry.get("blur");
	const layer = new EffectLayerNode({
		effectType: "blur",
		effectParams: buildDefaultParamValues(definition.params),
		timeOffset,
		duration,
	});
	const limits = spyOn(graphics, "getRendererLimits")
		.mockReturnValue({ maxTextureDimension: 4096, maxSurfaceDimension: 4096 });
	const doc = globalThis.document;
	Object.defineProperty(globalThis, "document", {
		value: { createElement: () => ({ width: 0, height: 0 }) },
		configurable: true,
	});
	try {
		const renderer = new CanvasRenderer({ width: 1920, height: 1080, fps });
		const root = new RootNode({ duration: 10 }).add(layer);
		const end = timeOffset + duration;

		await resolveRenderTree({ node: root, renderer, time: timeOffset });
		expect(layer.resolved).not.toBeNull();

		await resolveRenderTree({ node: root, renderer, time: end - frame });
		expect(layer.resolved).not.toBeNull();

		await resolveRenderTree({ node: root, renderer, time: end });
		expect(layer.resolved).toBeNull();

		await resolveRenderTree({ node: root, renderer, time: timeOffset - frame });
		expect(layer.resolved).toBeNull();
	} finally {
		limits.mockRestore();
		if (doc) Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
		else Reflect.deleteProperty(globalThis, "document");
	}
});