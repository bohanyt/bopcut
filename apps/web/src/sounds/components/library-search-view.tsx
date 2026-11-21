"use client";

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
	labels: Record<string, string>;
	placeholder: string;
	empty: string;
};

const SFX: LibraryConfig = {
	endpoint: "/api/agent/sfx",
	sources: SFX_SOURCES,
	labels: { library: "My folders", myinstants: "Myinstants" },
	placeholder: "Search sounds, e.g. vine boom",
	empty: "Search your own sound folders and Myinstants. Added sounds are kept, so they show up under My folders next time.",
};

const MUSIC: LibraryConfig = {
	endpoint: "/api/agent/music",
	sources: MUSIC_SOURCES,
	labels: { library: "My folders", online: "Online" },
	placeholder: "Search songs, e.g. nocturne op 9",
	empty: "Search your own music folders, or online (sound only, fetched with yt-dlp). Fetched songs are loudness-normalized and kept under My folders.",
};

const formatDuration = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/**
 * Searches a sound library (the user's folders plus an online source) and adds a result at the playhead:
 * the server saves it under the agent files root, then it is imported into the project.
 */
function LibrarySearchView({ config }: { config: LibraryConfig }) {
	const editor = useEditor();
	const [query, setQuery] = useState("");
	const [sources, setSources] = useState<string[]>([...config.sources]);
	const [results, setResults] = useState<Result[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState<string | null>(null);
	const [playing, setPlaying] = useState<string | null>(null);
	const audio = useRef<HTMLAudioElement | null>(null);

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
			setErrors((body.errors ?? []).map((e: { source: string; error: string }) => `${config.labels[e.source] ?? e.source}: ${e.error}`));
		} catch (error) {
			setResults([]);
			setErrors([error instanceof Error ? error.message : String(error)]);
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
			toast.error(`Cannot play ${result.name}`);
		});
		audio.current = player;
		setPlaying(result.ref);
	};

	const add = async (result: Result) => {
		const session = editor.media.startImport();
		if (!session) return;
		setAdding(result.ref);
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
			toast(`Added ${saved.name}`);
		} catch (error) {
			if (!session.signal.aborted) toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setAdding(null);
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
				<Input placeholder={config.placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
				<Button type="submit" variant="outline" disabled={searching || !query.trim() || !sources.length}>
					{searching ? "…" : "Search"}
				</Button>
			</form>
			<div className="flex gap-1.5">
				{config.sources.map((source) => {
					const on = sources.includes(source);
					return (
						<Button key={source} size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onClick={() => setSources(on ? sources.filter((s) => s !== source) : [...sources, source])}>
							{config.labels[source] ?? source}
						</Button>
					);
				})}
			</div>
			{errors.map((error) => (
				<p key={error} className="text-destructive text-xs">
					{error}
				</p>
			))}
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-3">
					{results.map((result) => (
						<div key={`${result.source}:${result.ref}`} className="group flex items-center gap-3">
							<button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => togglePlay(result)} title={result.previewUrl ? "Listen" : "Open its page"}>
								<div className="bg-accent flex size-10 shrink-0 items-center justify-center rounded-md">
									<HugeiconsIcon icon={!result.previewUrl ? Link01Icon : playing === result.ref ? PauseIcon : PlayIcon} className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">{result.name}</p>
									<span className="text-muted-foreground block truncate text-xs">
										{[config.labels[result.source] ?? result.source, formatDuration(result.duration), result.tags.join(" / ")].filter(Boolean).join(" · ")}
									</span>
								</div>
							</button>
							<Button
								variant="text"
								size="icon"
								className={cn("text-muted-foreground hover:text-foreground w-auto", adding === result.ref && "animate-pulse")}
								onClick={() => add(result)}
								disabled={adding !== null}
								title="Add at the playhead"
								aria-label={`Add ${result.name} at the playhead`}
							>
								<HugeiconsIcon icon={PlusSignIcon} />
							</Button>
						</div>
					))}
					{!searching && !results.length && !errors.length && <p className="text-muted-foreground text-sm">{config.empty}</p>}
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
