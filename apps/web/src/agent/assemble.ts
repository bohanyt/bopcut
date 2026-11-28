/**
 * Builds the first draft of a narrated video from its script: one voice clip per script line, back
 * to back, a caption per line from the words spoken in it, and the line's visual on the main track
 * (or a labelled placeholder where the plan has none yet). The result is ordinary draft ops.
 */

/** A script line: its code (`A01`) and its text. */
export type ScriptLine = { code: string; text: string };

/** A spoken word, in seconds of the voice file. */
export type VoiceWord = { text: string; start: number; end: number };

/** The voice of one line: a file, or a span of a longer take. */
export type LineVoice = { path: string; duration: number; start?: number; words?: VoiceWord[] };

/** What a line shows, from the plan. */
export type LineVisual = {
	/** What the shot is (`news`, `tech`, `footage`...): named on placeholders and in the result. */
	kind?: string;
	asset?: { path: string; type: "image" | "video"; name?: string };
	/** Seconds into a video asset. */
	trimStart?: number;
	/** What to find or make, shown on the placeholder. */
	note?: string;
	params?: Record<string, unknown>;
};

export type AssemblePlan = Record<string, { visual?: LineVisual; voice?: { path: string; start?: number; end?: number } }>;

export type AssembleOptions = {
	/** Seconds of silence between lines (default 0: no gaps). */
	gap?: number;
	/** Where the first line starts on the timeline. */
	start?: number;
	/** A caption preset for every line's caption. */
	captionPreset?: string;
	/** Track names. */
	tracks?: { voice?: string; captions?: string; visuals?: string; placeholders?: string };
};

const CODE = /^\s*([A-Za-z]{1,4}\d{1,4}[a-z]?)\s*[.:)]\s+(.+?)\s*$/;

/** The lines of a script file: `A01. Text of the line`, one per line; other lines are left out. */
export function parseScript(text: string): ScriptLine[] {
	const lines: ScriptLine[] = [];
	const seen = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const match = CODE.exec(raw);
		if (!match) continue;
		const code = match[1].toUpperCase();
		if (seen.has(code)) throw new Error(`Line ${code} appears twice in the script.`);
		seen.add(code);
		lines.push({ code, text: match[2] });
	}
	return lines;
}

/** The duration of a PCM WAV file from its header, or null when it is not one. */
export function wavDuration(bytes: Uint8Array): number | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
	let byteRate = 0;
	for (let at = 12; at + 8 <= bytes.length;) {
		const id = tag(at), size = view.getUint32(at + 4, true);
		if (id === "fmt " && at + 16 <= bytes.length) byteRate = view.getUint32(at + 16, true);
		if (id === "data") return byteRate > 0 ? Math.min(size, bytes.length - at - 8) / byteRate : null;
		at += 8 + size + (size % 2);
	}
	return null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The draft ops for a script. Lines without a voice are left out (listed in `missing`); lines without
 * a visual get a placeholder that names the line and its kind.
 */
export function assembleDraft({ lines, voices, plan = {}, options = {} }: {
	lines: ScriptLine[];
	voices: Map<string, LineVoice>;
	plan?: AssemblePlan;
	options?: AssembleOptions;
}) {
	const gap = options.gap ?? 0;
	const names = { voice: "VO", captions: "Captions", visuals: "Main", placeholders: "Placeholders", ...options.tracks };
	const ops: Record<string, unknown>[] = [];
	const placed: { code: string; start: number; duration: number; visual: string }[] = [];
	const missing: { code: string; reason: string }[] = [];
	let time = options.start ?? 0;
	for (const [index, line] of lines.entries()) {
		const voice = voices.get(line.code);
		if (!voice || !(voice.duration > 0)) {
			missing.push({ code: line.code, reason: "no voice take" });
			continue;
		}
		const trim = voice.start ?? 0;
		const duration = round(voice.duration);
		const start = round(time);
		const spoken = (voice.words ?? [])
			.filter((word) => word.end > trim && word.start < trim + duration && word.text.trim())
			.map((word) => ({ text: word.text.trim(), start: round(Math.max(0, word.start - trim)), end: round(Math.min(duration, word.end - trim)) }))
			.filter((word) => word.end > word.start);
		ops.push({ op: "add", track: { name: names.voice, type: "audio" }, element: {
			agent_id: `vo-${line.code}`, name: line.code, start, duration, trimStart: round(trim),
			asset: { path: voice.path, type: "audio", name: line.code, ...(voice.words?.length && { words: voice.words }) },
		} });
		// A caption of the words as spoken (their text must match the timings), else the script line.
		const caption = spoken.length
			? { text: spoken.map((word) => word.text).join(" "), words: spoken }
			: { text: line.text };
		ops.push({ op: "add", track: { name: names.captions }, element: {
			agent_id: `cap-${line.code}`, name: line.code, start, duration,
			caption: { ...caption, ...(options.captionPreset && { preset: options.captionPreset }) },
		} });
		// The picture lasts until the next line starts, so no gap shows black.
		const last = index === lines.length - 1;
		const shown = round(duration + (last ? 0 : gap));
		const visual = plan[line.code]?.visual;
		if (visual?.asset) {
			ops.push({ op: "add", track: { name: names.visuals, type: "video" }, element: {
				agent_id: `vis-${line.code}`, name: `${line.code}${visual.kind ? ` ${visual.kind}` : ""}`, start, duration: shown,
				...(visual.trimStart !== undefined && { trimStart: visual.trimStart }),
				asset: { name: line.code, ...visual.asset },
				...(visual.params && { params: visual.params }),
			} });
			placed.push({ code: line.code, start, duration, visual: visual.asset.path });
		} else {
			const label = [`[${line.code}${visual?.kind ? ` · ${visual.kind}` : ""}]`, visual?.note].filter(Boolean).join(" ");
			ops.push({ op: "add", track: { name: names.placeholders }, element: {
				agent_id: `todo-${line.code}`, name: `${line.code} placeholder`, start, duration: shown, caption: { text: label },
			} });
			placed.push({ code: line.code, start, duration, visual: "placeholder" });
		}
		time = start + duration + gap;
	}
	return { ops, placed, missing, duration: round(Math.max(0, time - gap - (options.start ?? 0))) };
}
