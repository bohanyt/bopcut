import { en } from "./en";
import { id } from "./id";
import type { Locale } from "./locale";

const dictionaries = { en, id };

export type MessageKey = keyof typeof en;

type Placeholder<Text extends string> =
	Text extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholder<Rest> : never;

export type StaticMessageKey = {
	[Key in MessageKey]: Placeholder<(typeof en)[Key]> extends never ? Key : never;
}[MessageKey];

export const placeholderPattern = /\{([^{}]+)\}/g;

export function createTranslator(locale: Locale) {
	return <Key extends MessageKey>(
		key: Key,
		...args: Placeholder<(typeof en)[Key]> extends never
			? []
			: [values: Record<Placeholder<(typeof en)[Key]>, string | number>]
	): string => {
		const [values]: [Record<string, string | number>?] = args;
		const message = dictionaries[locale][key];
		return values
			? message.replace(placeholderPattern, (match, name: string) =>
					Object.hasOwn(values, name) ? String(values[name]) : match,
				)
			: message;
	};
}
