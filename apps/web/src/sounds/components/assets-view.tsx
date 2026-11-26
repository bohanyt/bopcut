"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useSoundSearch } from "@/sounds/use-sound-search";
import { useSoundsStore } from "@/sounds/sounds-store";
import { MusicLibraryView, SfxLibraryView } from "@/sounds/components/library-search-view";
import type { SavedSound, SoundEffect } from "@/sounds/types";
import { cn } from "@/utils/ui";
import {
	FavouriteIcon,
	FilterMailIcon,
	PauseIcon,
	PlayIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function SoundsView() {
	const { t } = useI18n();
	return (
		<div className="flex h-full flex-col">
			<Tabs defaultValue="library" className="flex h-full flex-col">
				<div className="px-3 pt-4 pb-0">
					<TabsList className="flex flex-wrap">
						<TabsTrigger value="library">{t("sounds.library")}</TabsTrigger>
						<TabsTrigger value="music">{t("sounds.music")}</TabsTrigger>
						<TabsTrigger value="sound-effects">{t("sounds.effects")}</TabsTrigger>
						<TabsTrigger value="saved">{t("common.saved")}</TabsTrigger>
					</TabsList>
				</div>
				<Separator className="my-4" />
				<TabsContent
					value="library"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SfxLibraryView />
				</TabsContent>
				<TabsContent
					value="music"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<MusicLibraryView />
				</TabsContent>
				<TabsContent
					value="sound-effects"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SoundEffectsView />
				</TabsContent>
				<TabsContent
					value="saved"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SavedSoundsView />
				</TabsContent>
			</Tabs>
		</div>
	);
}

/** Plays one sound preview at a time; a preview that cannot play says so. */
function useSoundPreview() {
	const { t } = useI18n();
	const [playingId, setPlayingId] = useState<number | null>(null);
	const player = useRef<HTMLAudioElement | null>(null);
	// Leaving the tab stops the preview.
	useEffect(() => () => player.current?.pause(), []);

	const toggle = ({ sound }: { sound: SoundEffect }) => {
		player.current?.pause();
		if (playingId === sound.id) {
			player.current = null;
			setPlayingId(null);
			return;
		}
		if (!sound.previewUrl) {
			player.current = null;
			setPlayingId(null);
			toast.error(t("sounds.playFailed", { name: sound.name }));
			return;
		}
		const audio = new Audio(sound.previewUrl);
		const stopped = () => {
			if (player.current !== audio) return false;
			player.current = null;
			setPlayingId(null);
			return true;
		};
		const failed = () => {
			if (stopped()) toast.error(t("sounds.playFailed", { name: sound.name }), { id: `sound-preview-${sound.id}` });
		};
		audio.addEventListener("ended", stopped);
		audio.addEventListener("error", failed);
		audio.play().catch(failed);
		player.current = audio;
		setPlayingId(sound.id);
	};
	return { playingId, toggle };
}

export function SoundEffectsView() {
	const { t } = useI18n();
	// Only what is shown: a store update elsewhere (a saved sound, a search page) leaves this list alone.
	const { topSoundEffects, isLoading, loadError, searchQuery, showCommercialOnly, hasLoaded } = useSoundsStore(
		useShallow((state) => ({
			topSoundEffects: state.topSoundEffects,
			isLoading: state.isLoading,
			loadError: state.error,
			searchQuery: state.searchQuery,
			showCommercialOnly: state.showCommercialOnly,
			hasLoaded: state.hasLoaded,
		})),
	);
	const { setSearchQuery, toggleCommercialFilter, loadSavedSounds } = useSoundsStore.getState();
	const {
		results: searchResults,
		isLoading: isSearching,
		error: searchError,
		retry: retrySearch,
		loadMore,
		hasNextPage,
		isLoadingMore,
	} = useSoundSearch({
		query: searchQuery,
		commercialOnly: showCommercialOnly,
	});
	const [loadAttempt, setLoadAttempt] = useState(0);
	const { playingId, toggle: playSound } = useSoundPreview();

	const displayedSounds = searchQuery ? searchResults : topSoundEffects;
	const failure = searchQuery
		? searchError && !isSearching
			? displayedSounds.length === 0
				? { message: t("sounds.searchFailed"), retry: retrySearch }
				: { message: t("sounds.loadMoreFailed"), retry: loadMore }
			: null
		: loadError && !isLoading && topSoundEffects.length === 0
			? { message: t("sounds.loadFailed"), retry: () => setLoadAttempt((count) => count + 1) }
			: searchError && topSoundEffects.length > 0
				? { message: t("sounds.loadMoreFailed"), retry: loadMore }
				: null;

	const { scrollAreaRef, handleScroll } = useInfiniteScroll({
		onLoadMore: loadMore,
		hasMore: hasNextPage,
		isLoading: isLoadingMore || isSearching,
		// After a failed page, the Retry button loads it: scrolling would retry it on every event.
		enabled: !failure,
	});

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	useEffect(() => {
		if (hasLoaded) {
			return;
		}

		let shouldIgnore = false;
		const store = useSoundsStore.getState();

		const fetchTopSounds = async () => {
			try {
				if (!shouldIgnore) {
					store.setLoading({ loading: true });
					store.setError({ error: null });
				}

				const response = await fetch(
					`/api/sounds/search?page_size=50&sort=downloads&commercial_only=${useSoundsStore.getState().showCommercialOnly}`,
				);

				if (!shouldIgnore) {
					if (!response.ok) {
						throw new Error(`Failed to fetch: ${response.status}`);
					}

					const data = await response.json();
					store.setTopSoundEffects({ sounds: data.results });
					store.setHasLoaded({ loaded: true });

					store.setCurrentPage({ page: 1 });
					store.setHasNextPage({ hasNext: !!data.next });
					store.setTotalCount({ count: data.count });
				}
			} catch (error) {
				if (!shouldIgnore) {
					console.error("Failed to fetch top sounds:", error);
					store.setError({
						error:
							error instanceof Error ? error.message : "Failed to load sounds",
					});
				}
			} finally {
				if (!shouldIgnore) {
					store.setLoading({ loading: false });
				}
			}
		};

		const timeoutId = setTimeout(fetchTopSounds, 100, {});

		return () => {
			shouldIgnore = true;
			clearTimeout(timeoutId);
		};
	}, [hasLoaded, loadAttempt]);

	// The scroll position is kept for the next time the tab opens. It is written once, when the tab
	// closes: a store write on every scroll event re-rendered the whole list.
	const scrollTop = useRef(useSoundsStore.getState().scrollPosition);
	useEffect(() => {
		const restoreTo = scrollTop.current;
		const timeoutId = restoreTo > 0
			? setTimeout(() => scrollAreaRef.current?.scrollTo({ top: restoreTo }), 100)
			: undefined;
		return () => {
			clearTimeout(timeoutId);
			useSoundsStore.getState().setScrollPosition({ position: scrollTop.current });
		};
	}, [scrollAreaRef]);

	const handleScrollWithPosition = (event: React.UIEvent<HTMLDivElement>) => {
		scrollTop.current = event.currentTarget.scrollTop;
		handleScroll(event);
	};

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center gap-3">
				<Input
					placeholder={t("sounds.searchEffects")}
					aria-label={t("sounds.searchEffects")}
					className="w-full"
					containerClassName="w-full"
					value={searchQuery}
					onChange={({ currentTarget }) =>
						setSearchQuery({ query: currentTarget.value })
					}
					showClearIcon
					onClear={() => setSearchQuery({ query: "" })}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className={cn(showCommercialOnly && "text-primary")}
							aria-label={t("sounds.licenseFilter")}
							title={t("sounds.licenseFilter")}
						>
							<HugeiconsIcon icon={FilterMailIcon} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuCheckboxItem
							checked={showCommercialOnly}
							onCheckedChange={() => toggleCommercialFilter()}
						>
							{t("sounds.commercialOnly")}
						</DropdownMenuCheckboxItem>
						<div className="text-muted-foreground px-2 py-1.5 text-xs">
							{showCommercialOnly
								? t("sounds.commercialFilterOn")
								: t("sounds.commercialFilterOff")}
						</div>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="relative h-full overflow-hidden">
				<ScrollArea
					className="h-full flex-1"
					ref={scrollAreaRef}
					onScrollCapture={handleScrollWithPosition}
				>
					<div className="flex flex-col gap-4">
						{isLoading && !searchQuery && (
							<div className="text-muted-foreground text-sm">
								{t("sounds.loading")}
							</div>
						)}
						{isSearching && searchQuery && (
							<div className="text-muted-foreground text-sm">{t("sounds.searching")}</div>
						)}
						{displayedSounds.map((sound) => (
							<AudioItem
								key={sound.id}
								sound={sound}
								isPlaying={playingId === sound.id}
								onPlay={playSound}
							/>
						))}
						{failure && (
							<div role="alert" className="flex flex-col items-start gap-2 text-sm">
								<p className="text-destructive">{failure.message}</p>
								<Button variant="outline" size="sm" onClick={() => failure.retry()}>
									{t("common.retry")}
								</Button>
							</div>
						)}
						{!failure && !isLoading && !isSearching && displayedSounds.length === 0 && (
							<div className="text-muted-foreground text-sm">
								{searchQuery ? t("sounds.noMatches") : t("sounds.empty")}
							</div>
						)}
						{isLoadingMore && (
							<div className="text-muted-foreground py-4 text-center text-sm">
								{t("sounds.loadingMore")}
							</div>
						)}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}

export function SavedSoundsView() {
	const { t } = useI18n();
	const { savedSounds, isLoadingSavedSounds, savedSoundsError } = useSoundsStore(
		useShallow((state) => ({
			savedSounds: state.savedSounds,
			isLoadingSavedSounds: state.isLoadingSavedSounds,
			savedSoundsError: state.savedSoundsError,
		})),
	);
	const { loadSavedSounds, clearSavedSounds } = useSoundsStore.getState();
	const { playingId, toggle: playSound } = useSoundPreview();

	const [showClearDialog, setShowClearDialog] = useState(false);

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	const convertToSoundEffect = ({
		savedSound,
	}: {
		savedSound: SavedSound;
	}): SoundEffect => ({
		id: savedSound.id,
		name: savedSound.name,
		description: "",
		url: "",
		previewUrl: savedSound.previewUrl,
		downloadUrl: savedSound.downloadUrl,
		duration: savedSound.duration,
		filesize: 0,
		type: "audio",
		channels: 0,
		bitrate: 0,
		bitdepth: 0,
		samplerate: 0,
		username: savedSound.username,
		tags: savedSound.tags,
		license: savedSound.license,
		created: savedSound.savedAt,
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	});

	if (isLoadingSavedSounds) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-muted-foreground text-sm">
					{t("sounds.loadingSaved")}
				</div>
			</div>
		);
	}

	if (savedSoundsError) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-destructive text-sm">
					{t("sounds.error", { message: localizeErrorDetail(savedSoundsError, t) })}
				</div>
			</div>
		);
	}

	if (savedSounds.length === 0) {
		return (
			<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
				<HugeiconsIcon
					icon={FavouriteIcon}
					className="text-muted-foreground size-10"
				/>
				<div className="flex flex-col gap-2 text-center">
					<p className="text-lg font-medium">{t("sounds.noneSaved")}</p>
					<p className="text-muted-foreground text-sm text-balance">
						{t("sounds.saveHint")}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center justify-between">
				<p className="text-muted-foreground text-sm">
					{t(savedSounds.length === 1 ? "sounds.savedOne" : "sounds.savedCount", { count: savedSounds.length })}
				</p>
				<Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
					<DialogTrigger asChild>
						<Button
							variant="text"
							size="sm"
							className="text-muted-foreground hover:text-destructive h-auto !opacity-100"
						>
							{t("sounds.clearAll")}
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("sounds.clearConfirm")}</DialogTitle>
							<DialogDescription>
								{t("sounds.clearDescription", { count: savedSounds.length })}
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="text" onClick={() => setShowClearDialog(false)}>
								{t("common.cancel")}
							</Button>
							<Button
								variant="destructive"
								onClick={async () => {
									await clearSavedSounds();
									setShowClearDialog(false);
								}}
							>
								{t("sounds.clearSounds")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			<div className="relative h-full overflow-hidden">
				<ScrollArea className="h-full flex-1">
					<div className="flex flex-col gap-4">
						{savedSounds.map((sound) => (
							<AudioItem
								key={sound.id}
								sound={convertToSoundEffect({ savedSound: sound })}
								isPlaying={playingId === sound.id}
								onPlay={playSound}
							/>
						))}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}

interface AudioItemProps {
	sound: SoundEffect;
	isPlaying: boolean;
	onPlay: ({ sound }: { sound: SoundEffect }) => void;
}

export function AudioItem({ sound, isPlaying, onPlay }: AudioItemProps) {
	const { t } = useI18n();
	// Re-renders only when this sound is saved or unsaved.
	const isSaved = useSoundsStore((state) => state.savedSounds.some(({ id }) => id === sound.id));
	const [isAdding, setAdding] = useState(false);

	const handleClick = () => {
		onPlay({ sound });
	};

	// The buttons sit beside the play button, not inside it: there is no click to stop.
	const handleSaveClick = () => {
		useSoundsStore.getState().toggleSavedSound({ soundEffect: sound });
	};

	const handleAddToTimeline = async () => {
		if (isAdding) return;
		setAdding(true);
		try {
			if (await useSoundsStore.getState().addSoundToTimeline({ sound })) {
				toast(t("sounds.added", { name: sound.name }));
			}
		} finally {
			setAdding(false);
		}
	};

	return (
		<div className="group flex items-center gap-3 opacity-100 hover:opacity-75">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 text-left"
				onClick={handleClick}
			>
				<div className="bg-accent relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
					<div className="from-primary/20 absolute inset-0 bg-gradient-to-br to-transparent" />
					{isPlaying ? (
						<HugeiconsIcon icon={PauseIcon} className="size-5" />
					) : (
						<HugeiconsIcon icon={PlayIcon} className="size-5" />
					)}
				</div>

				<div className="min-w-0 flex-1 overflow-hidden">
					<p className="truncate text-sm font-medium">{sound.name}</p>
					<span className="text-muted-foreground block truncate text-xs">
						{sound.username}
					</span>
				</div>
			</button>

			<div className="flex items-center gap-3 pr-2">
				<Button
					variant="text"
					size="icon"
					className={cn("text-muted-foreground hover:text-foreground w-auto !opacity-100", isAdding && "animate-pulse")}
					onClick={handleAddToTimeline}
					disabled={isAdding}
					title={t("sounds.addAtPlayhead")}
					aria-label={t("sounds.addNamedAtPlayhead", { name: sound.name })}
				>
					<HugeiconsIcon icon={PlusSignIcon} />
				</Button>
				<Button
					variant="text"
					size="icon"
					className={`hover:text-foreground w-auto !opacity-100 ${
						isSaved
							? "text-red-500 hover:text-red-600"
							: "text-muted-foreground"
					}`}
					onClick={handleSaveClick}
					title={isSaved ? t("sounds.removeSaved") : t("sounds.saveSound")}
					aria-label={isSaved ? t("sounds.removeNamedSaved", { name: sound.name }) : t("sounds.saveNamed", { name: sound.name })}
					aria-pressed={isSaved}
				>
					<HugeiconsIcon
						icon={FavouriteIcon}
						className={`${isSaved ? "fill-current" : ""}`}
					/>
				</Button>
			</div>
		</div>
	);
}
