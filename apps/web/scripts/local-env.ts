import { existsSync, readFileSync } from "node:fs";

export const managedFolderComment = " # bopencut local path";

// Use dotenv's quoted-value boundaries, including multiline values and escaped delimiters.
// Keep the prefix and comment separate so updates preserve surrounding text.
export const assignment = /^(\s*(?:export\s+)?([\w.-]+)(?:\s*=[\t ]*|:\s+?))(\s*"(?:\\"|[^"])*"|\s*'(?:\\'|[^'])*'|\s*\x60(?:\\\x60|[^\x60])*\x60|[^#\r\n]*?)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;

function decodeValue(raw: string): string {
	return raw.trim()
		.replace(/^(["'\x60])([\s\S]*)\1$/, (_, quote: string, value: string) =>
			quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : value,
		)
		.replace(/\\\$/g, "$");
}

export function envValues(source: string): Record<string, string> {
	return Object.fromEntries(Array.from(source.matchAll(assignment), ([, , key, raw]) => [key, decodeValue(raw)]));
}

export function directEnvValues(source: string): Record<string, string> {
	const values = new Map<string, string>();

	// Direct-file commands historically read literal, single-line values.
	for (const line of source.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match || values.has(match[1])) continue;
		values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, "$2"));
	}

	// Decode only the folder values written by the launcher using dotenv syntax.
	const settings = envValues(source);
	for (const [, , key, , suffix] of source.matchAll(assignment)) {
		if ((key === "AGENT_FILES_ROOT" || key === "BOPENCUT_DATA") && suffix.endsWith(managedFolderComment)) {
			values.set(key, settings[key]);
		}
	}
	return Object.fromEntries(values);
}

export function loadEnvLocal(file: string) {
	if (!existsSync(file)) return;
	for (const [key, value] of Object.entries(directEnvValues(readFileSync(file, "utf8")))) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
