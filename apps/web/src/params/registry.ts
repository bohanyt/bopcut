import type { StaticMessageKey } from "@/i18n/translate";
import type {
	ParamDefinition,
	ParamValue,
	ParamValues,
} from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { BlendMode } from "@/rendering";
import type {
	ElementType,
	TimelineElement,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { textStyleParams } from "@/text/style";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
} from "@/text/background";

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({
		key,
		definition,
	}: {
		key: TKey;
		definition: TDefinition;
	}): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			throw new Error(`Unknown ${this.entityName}: ${key}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; labelKey: StaticMessageKey }> = [
	{ value: "normal", labelKey: "params.normal" },
	{ value: "darken", labelKey: "params.darken" },
	{ value: "multiply", labelKey: "params.multiply" },
	{ value: "color-burn", labelKey: "params.colorBurn" },
	{ value: "lighten", labelKey: "params.lighten" },
	{ value: "screen", labelKey: "params.screen" },
	{ value: "plus-lighter", labelKey: "params.plusLighter" },
	{ value: "color-dodge", labelKey: "params.colorDodge" },
	{ value: "overlay", labelKey: "params.overlay" },
	{ value: "soft-light", labelKey: "params.softLight" },
	{ value: "hard-light", labelKey: "params.hardLight" },
	{ value: "difference", labelKey: "params.difference" },
	{ value: "exclusion", labelKey: "params.exclusion" },
	{ value: "hue", labelKey: "params.hue" },
	{ value: "saturation", labelKey: "params.saturation" },
	{ value: "color", labelKey: "common.color" },
	{ value: "luminosity", labelKey: "params.luminosity" },
];

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		labelKey: "params.positionX",
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.positionY",
		labelKey: "params.positionY",
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.scaleX",
		labelKey: "params.scaleX",
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.scaleY",
		labelKey: "params.scaleY",
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.rotate",
		labelKey: "params.rotate",
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
	},
	{
		key: "shake.intensity",
		labelKey: "params.shake",
		type: "number",
		default: 0,
		min: 0,
		max: 400,
		step: 0.5,
	},
	{
		key: "shake.frequency",
		labelKey: "params.shakeSpeed",
		type: "number",
		default: 8,
		min: 0.1,
		max: 60,
		step: 0.1,
		keyframable: false,
	},
	{
		key: "shake.rotation",
		labelKey: "params.shakeRotation",
		type: "number",
		default: 0,
		min: 0,
		max: 45,
		step: 0.1,
		keyframable: false,
	},
	{
		key: "shake.seed",
		labelKey: "params.shakePattern",
		type: "number",
		default: 1,
		min: 0,
		max: 9999,
		step: 1,
		keyframable: false,
	},
	{
		key: "opacity",
		labelKey: "params.opacity",
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "blendMode",
		labelKey: "params.blendMode",
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

export const model3dParams: ElementParamDefinition[] = [
	{ key: "rotationX", labelKey: "params.rotationX", type: "number", default: 0, min: -3600, max: 3600, step: 1 },
	{ key: "rotationY", labelKey: "params.rotationY", type: "number", default: 0, min: -3600, max: 3600, step: 1 },
	{ key: "rotationZ", labelKey: "params.rotationZ", type: "number", default: 0, min: -3600, max: 3600, step: 1 },
	{ key: "modelScale", labelKey: "params.modelScale", type: "number", default: 1, min: 0.01, max: 10, step: 0.01 },
	{ key: "cameraDistance", labelKey: "params.cameraDistance", type: "number", default: 3.5, min: 0.1, max: 50, step: 0.1 },
	{ key: "cameraFov", labelKey: "params.cameraFov", type: "number", default: 45, min: 5, max: 150, step: 1 },
	{ key: "lightIntensity", labelKey: "params.lightIntensity", type: "number", default: 2, min: 0, max: 10, step: 0.1 },
	{ key: "lightX", labelKey: "params.lightX", type: "number", default: 3, min: -20, max: 20, step: 0.1 },
	{ key: "lightY", labelKey: "params.lightY", type: "number", default: 4, min: -20, max: 20, step: 0.1 },
	{ key: "lightZ", labelKey: "params.lightZ", type: "number", default: 5, min: -20, max: 20, step: 0.1 },
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		labelKey: "params.volume",
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
	},
	{
		key: "fadeIn",
		labelKey: "params.fadeIn",
		type: "number",
		default: 0,
		min: 0,
		max: 30,
		step: 0.01,
		keyframable: false,
	},
	{
		key: "fadeOut",
		labelKey: "params.fadeOut",
		type: "number",
		default: 0,
		min: 0,
		max: 30,
		step: 0.01,
		keyframable: false,
	},
	{
		key: "muted",
		labelKey: "params.muted",
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		labelKey: "params.content",
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		labelKey: "params.fontFamily",
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		labelKey: "params.fontSize",
		type: "number",
		default: 15,
		min: 1,
		step: 1,
	},
	{
		key: "color",
		labelKey: "common.color",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textAlign",
		labelKey: "params.textAlign",
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", labelKey: "params.left" },
			{ value: "center", labelKey: "params.center" },
			{ value: "right", labelKey: "params.right" },
		],
	},
	{
		key: "fontWeight",
		labelKey: "params.fontWeight",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", labelKey: "params.normal" },
			{ value: "bold", labelKey: "params.bold" },
		],
	},
	{
		key: "fontStyle",
		labelKey: "params.fontStyle",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", labelKey: "params.normal" },
			{ value: "italic", labelKey: "params.italic" },
		],
	},
	{
		key: "textDecoration",
		labelKey: "params.textDecoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", labelKey: "params.none" },
			{ value: "underline", labelKey: "params.underline" },
			{ value: "line-through", labelKey: "params.lineThrough" },
		],
	},
	{
		key: "letterSpacing",
		labelKey: "params.letterSpacing",
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
	},
	{
		key: "lineHeight",
		labelKey: "params.lineHeight",
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
	},
	{
		// Share of the characters shown, in reading order (the typewriter animation animates it).
		key: "typewriter",
		labelKey: "params.typed",
		type: "number",
		default: 1,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "background.enabled",
		labelKey: "params.backgroundEnabled",
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		labelKey: "params.backgroundColor",
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		labelKey: "params.backgroundRadius",
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		labelKey: "params.backgroundPaddingX",
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		labelKey: "params.backgroundPaddingY",
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		labelKey: "params.backgroundOffsetX",
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		labelKey: "params.backgroundOffsetY",
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

export const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [...visualElementParams, ...audioElementParams],
});
elementParamRegistry.register({ key: "image", definition: [...visualElementParams, ...model3dParams] });
elementParamRegistry.register({
	key: "text",
	definition: [...textElementParams, ...textStyleParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "sticker",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "graphic",
	definition: visualElementParams,
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });
// Compound volume is a single gain for now: keyframes and fades would not reach the nested audio mix yet.
elementParamRegistry.register({
	key: "compound",
	definition: [
		...visualElementParams,
		...audioElementParams
			.filter((param) => param.key !== "fadeIn" && param.key !== "fadeOut")
			.map((param) =>
				param.key === "volume" ? { ...param, keyframable: false } : param,
			),
	],
});

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}

export function buildElementParamValues({
	element,
}: {
	element: TimelineElement;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of getElementParams({ element })) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

