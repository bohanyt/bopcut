"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import type { StaticMessageKey } from "@/i18n/translate";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AddMediaAssetCommand, BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { cn } from "@/utils/ui";
import { Link01Icon, PauseIcon, PlayIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SFX_SOURCES } from "../sfx-types";
import { MUSIC_SOURCES } from "../music-types";

type Result = { source: string; ref: string; name: string; tags: string[]; duration?: number; previewUrl?: string; pageUrl?: string };
type Saved = { path: string; name: string; error?: string };

type LibraryConfig = {
	/** POST endpoint with `search` and `get` kinds. */
	endpoint: string;
	sources: readonly string[];
	labels: Partial<Record<string, StaticMessageKey>>;
	placeholder: StaticMessageKey;
	empty: StaticMessageKey;
};

const SFX: LibraryConfig = {
	endpoint: "/api/agent/sfx",
	sources: SFX_SOURCES,
	labels: { library: "sounds.myFolders", myinstants: "sounds.myinstants" },
	placeholder: "sounds.searchSuggestions",
	empty: "sounds.libraryHint",
};

const MUSIC: LibraryConfig = {
	endpoint: "/api/agent/music",
	sources: MUSIC_SOURCES,
	labels: { library: "sounds.myFolders", online: "sounds.online" },
	placeholder: "sounds.musicSuggestions",
	empty: "sounds.musicHint",
};

const formatDuration = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
const resultKey = ({ source, ref }: Result) => `${source}:${ref}`;

/**
 * Searches a sound library (the user's folders plus an online source) and adds a result at the playhead:
 * the server saves it under the agent files root, then it is imported into the project.
 */
function LibrarySearchView({ config }: { config: LibraryConfig }) {
	const { t } = useI18n();
	const editor = useEditor();
	const [query, setQuery] = useState("");
	const [sources, setSources] = useState<string[]>([...config.sources]);
	const [results, setResults] = useState<Result[]>([]);
	const [errors, setErrors] = useState<{ source?: string; error: string }[]>([]);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
	const [playing, setPlaying] = useState<string | null>(null);
	const audio = useRef<HTMLAudioElement | null>(null);
	const sourceLabel = (source: string) => {
		const labelKey = config.labels[source];
		return labelKey ? t(labelKey) : source;
	};

	useEffect(() => () => audio.current?.pause(), []);

	const post = async (body: unknown, signal?: AbortSignal) => {
		const res = await fetch(config.endpoint, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
		return data;
	};

	const search = async () => {
		if (!query.trim() || !sources.length) return;
		setSearching(true);
		try {
			const body = await post({ kind: "search", query: query.trim(), sources });
			setResults(body.results ?? []);
			setErrors(body.errors ?? []);
		} catch (error) {
			setResults([]);
			setErrors([{ error: error instanceof Error ? error.message : String(error) }]);
		} finally {
			setSearching(false);
		}
	};

	const togglePlay = (result: Result) => {
		audio.current?.pause();
		if (!result.previewUrl) {
			if (result.pageUrl) window.open(result.pageUrl, "_blank", "noopener,noreferrer");
			return;
		}
		if (playing === result.ref) {
			setPlaying(null);
			return;
		}
		const player = new Audio(result.previewUrl);
		player.addEventListener("ended", () => setPlaying(null));
		player.play().catch(() => {
			setPlaying(null);
			toast.error(t("sounds.playFailed", { name: result.name }));
		});
		audio.current = player;
		setPlaying(result.ref);
	};

	const add = async (result: Result) => {
		const key = resultKey(result);
		const session = editor.media.startImport();
		if (!session || adding.has(key)) return;
		setAdding((pending) => new Set(pending).add(key));
		try {
			const saved = (await post({ kind: "get", source: result.source, ref: result.ref, name: result.name, pageUrl: result.pageUrl }, session.signal)) as Saved;
			if (session.signal.aborted) return;
			const file = await fetch(`/api/agent/file?p=${encodeURIComponent(saved.path)}`, { signal: session.signal });
			if (!file.ok) throw new Error("the saved file could not be read");
			const blob = await file.blob();
			const ext = saved.path.split(".").pop() ?? "m4a";
			if (session.signal.aborted) return;
			const asset = await editor.media.importFile({ session, file: new File([blob], `${saved.name}.${ext}`, { type: blob.type }) });
			if (session.signal.aborted || !asset) return;
			if (!editor.media.getAssets().some(({ id }) => id === asset.id)) return;
			const element = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: saved.name,
				duration: asset.duration != null ? mediaTimeFromSeconds({ seconds: asset.duration }) : DEFAULT_NEW_ELEMENT_DURATION,
				startTime: editor.playback.getCurrentTime(),
				buffer: new AudioBuffer({ length: 1, sampleRate: 44100 }),
			});
			const insert = new InsertElementCommand({ element, placement: { mode: "auto", trackType: "audio" } });
			const addMedia = new AddMediaAssetCommand({ projectId: session.projectId, assetId: asset.id });
			editor.command.execute({ command: new BatchCommand([addMedia, insert]) });
			toast(t("sounds.added", { name: saved.name }));
		} catch (error) {
			if (!session.signal.aborted) toast.error(localizeErrorDetail(error instanceof Error ? error.message : String(error), t));
		} finally {
			setAdding((pending) => {
				const remaining = new Set(pending);
				remaining.delete(key);
				return remaining;
			});
		}
	};

	return (
		<div className="flex h-full flex-col gap-3">
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					search();
				}}
			>
				<Input className="min-w-0" placeholder={t(config.placeholder)} value={query} onChange={(e) => setQuery(e.target.value)} />
				<Button type="submit" variant="outline" disabled={searching || !query.trim() || !sources.length}>
					{searching ? "…" : t("common.search")}
				</Button>
			</form>
			<div className="flex gap-1.5">
				{config.sources.map((source) => {
					const on = sources.includes(source);
					return (
						<Button key={source} size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onClick={() => setSources(on ? sources.filter((s) => s !== source) : [...sources, source])}>
							{sourceLabel(source)}
						</Button>
					);
				})}
			</div>
			{errors.map(({ source, error }) => (
				<p key={source ?? error} className="text-destructive text-xs">
					{source ? t("sounds.sourceError", { source: sourceLabel(source), message: localizeErrorDetail(error, t) }) : localizeErrorDetail(error, t)}
				</p>
			))}
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-3">
					{results.map((result) => (
						<div key={resultKey(result)} className="group flex items-center gap-3">
							<button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => togglePlay(result)} title={result.previewUrl ? t("sounds.listen") : t("sounds.openPage")}>
								<div className="bg-accent flex size-10 shrink-0 items-center justify-center rounded-md">
									<HugeiconsIcon icon={!result.previewUrl ? Link01Icon : playing === result.ref ? PauseIcon : PlayIcon} className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">{result.name}</p>
									<span className="text-muted-foreground block truncate text-xs">
										{[sourceLabel(result.source), formatDuration(result.duration), result.tags.join(" / ")].filter(Boolean).join(" · ")}
									</span>
								</div>
							</button>
							<Button
								variant="text"
								size="icon"
								className={cn("text-muted-foreground hover:text-foreground w-auto", adding.has(resultKey(result)) && "animate-pulse")}
								onClick={() => add(result)}
								disabled={adding.has(resultKey(result))}
								title={t("sounds.addAtPlayhead")}
								aria-label={t("sounds.addNamedAtPlayhead", { name: result.name })}
							>
								<HugeiconsIcon icon={PlusSignIcon} />
							</Button>
						</div>
					))}
					{!searching && !results.length && !errors.length && <p className="text-muted-foreground text-sm">{t(config.empty)}</p>}
				</div>
			</ScrollArea>
		</div>
	);
}

/** Sound effects from the user's own sound folders and myinstants.com, without an account or key. */
export function SfxLibraryView() {
	return <LibrarySearchView config={SFX} />;
}

/** Songs from the user's own music folders, or found online (sound only). */
export function MusicLibraryView() {
	return <LibrarySearchView config={MUSIC} />;
}
