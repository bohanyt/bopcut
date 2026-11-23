import { existsSync, readFileSync } from "node:fs";

// Match complete assignments so a line inside a quoted value is never edited on its own.
export const assignment = /^([\t \uFEFF]*(?:export[\t ]+)?([\w.-]+)(?:[\t ]*=[\t ]*|:[\t ]+))("[^"\\]*(?:\\[\s\S][^"\\]*)*"|'[^'\\]*(?:\\[\s\S][^'\\]*)*'|`[^`]*`|[^#\r\n]*?)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;

export function envValues(source: string): Record<string, string> {
	return Object.fromEntries(Array.from(source.matchAll(assignment), ([, , key, raw]) => [
		key,
		raw.trim()
			.replace(/^(["'`])([\s\S]*)\1$/, (_, quote: string, value: string) =>
				quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : value,
			)
			.replace(/\\\$/g, "$"),
	]));
}

export function loadEnvLocal(file: string) {
	if (!existsSync(file)) return;
	for (const [key, value] of Object.entries(envValues(readFileSync(file, "utf8")))) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
