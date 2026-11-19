"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BatchCommand } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { InsertElementCommand } from "@/commands/timeline";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { cn } from "@/utils/ui";
import { PauseIcon, PlayIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SFX_SOURCES, type SfxFile, type SfxResult, type SfxSource } from "../sfx-types";

const SOURCE_LABELS: Record<SfxSource, string> = { library: "My folders", myinstants: "Myinstants" };

/**
 * Sound effects from the user's own sound folders and myinstants.com, without an account or key.
 * Adding a sound saves it under the agent files root and imports it into the project at the playhead.
 */
export function SfxLibraryView() {
	const editor = useEditor();
	const [query, setQuery] = useState("");
	const [sources, setSources] = useState<SfxSource[]>([...SFX_SOURCES]);
	const [results, setResults] = useState<SfxResult[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState<string | null>(null);
	const [playing, setPlaying] = useState<string | null>(null);
	const audio = useRef<HTMLAudioElement | null>(null);

	useEffect(() => () => audio.current?.pause(), []);

	const search = async () => {
		if (!query.trim() || !sources.length) return;
		setSearching(true);
		try {
			const res = await fetch("/api/agent/sfx", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "search", query: query.trim(), sources }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error ?? `search failed (${res.status})`);
			setResults(body.results ?? []);
			setErrors((body.errors ?? []).map((e: { source: SfxSource; error: string }) => `${SOURCE_LABELS[e.source]}: ${e.error}`));
		} catch (error) {
			setResults([]);
			setErrors([error instanceof Error ? error.message : String(error)]);
		} finally {
			setSearching(false);
		}
	};

	const togglePlay = (result: SfxResult) => {
		audio.current?.pause();
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

	const add = async (result: SfxResult) => {
		const project = editor.project.getActive();
		if (!project) return;
		setAdding(result.ref);
		try {
			const res = await fetch("/api/agent/sfx", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "get", source: result.source, ref: result.ref, name: result.name, pageUrl: result.pageUrl }),
			});
			const saved = (await res.json().catch(() => ({}))) as SfxFile & { error?: string };
			if (!res.ok) throw new Error(saved.error ?? `request failed (${res.status})`);
			const file = await fetch(`/api/agent/file?p=${encodeURIComponent(saved.path)}`);
			if (!file.ok) throw new Error("the saved sound could not be read");
			const blob = await file.blob();
			const ext = saved.path.split(".").pop() ?? "mp3";
			const [asset] = await processMediaAssets({ files: [new File([blob], `${saved.name}.${ext}`, { type: blob.type })] });
			if (!asset) throw new Error("the sound could not be processed");
			// The download may take a while: only insert into the project it was started for.
			if (editor.project.getActive()?.metadata.id !== project.metadata.id) {
				toast.error(`${saved.name} was not added: another project is open now`);
				return;
			}
			const addMedia = new AddMediaAssetCommand({ projectId: project.metadata.id, asset });
			const element = buildElementFromMedia({
				mediaId: addMedia.getAssetId(),
				mediaType: asset.type,
				name: saved.name,
				duration: asset.duration != null ? mediaTimeFromSeconds({ seconds: asset.duration }) : DEFAULT_NEW_ELEMENT_DURATION,
				startTime: editor.playback.getCurrentTime(),
				buffer: new AudioBuffer({ length: 1, sampleRate: 44100 }),
			});
			const insert = new InsertElementCommand({ element, placement: { mode: "auto", trackType: "audio" } });
			editor.command.execute({ command: new BatchCommand([addMedia, insert]) });
			toast(`Added ${saved.name}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
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
				<Input placeholder="Search sounds, e.g. vine boom" value={query} onChange={(e) => setQuery(e.target.value)} />
				<Button type="submit" variant="outline" disabled={searching || !query.trim() || !sources.length}>
					{searching ? "…" : "Search"}
				</Button>
			</form>
			<div className="flex gap-1.5">
				{SFX_SOURCES.map((source) => {
					const on = sources.includes(source);
					return (
						<Button
							key={source}
							size="sm"
							variant={on ? "secondary" : "ghost"}
							aria-pressed={on}
							onClick={() => setSources(on ? sources.filter((s) => s !== source) : [...sources, source])}
						>
							{SOURCE_LABELS[source]}
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
							<button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => togglePlay(result)}>
								<div className="bg-accent flex size-10 shrink-0 items-center justify-center rounded-md">
									<HugeiconsIcon icon={playing === result.ref ? PauseIcon : PlayIcon} className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">{result.name}</p>
									<span className="text-muted-foreground block truncate text-xs">
										{SOURCE_LABELS[result.source]}
										{result.tags.length ? ` · ${result.tags.join(" / ")}` : ""}
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
					{!searching && !results.length && !errors.length && (
						<p className="text-muted-foreground text-sm">Search your own sound folders and Myinstants. Added sounds are kept, so they show up under My folders next time.</p>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
