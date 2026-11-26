import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSoundsStore } from "@/sounds/sounds-store";
import type { SoundEffect } from "@/sounds/types";

/** Adds one more fetched page to the search results (with a query) or to the top sounds. */
export function appendSoundsPage({ data, query, page }: {
	data: { results: SoundEffect[]; next?: string | null; count: number };
	query: string;
	page: number;
}): void {
	const store = useSoundsStore.getState();
	if (query.trim()) store.appendSearchResults({ results: data.results });
	else store.appendTopSounds({ results: data.results });
	store.setCurrentPage({ page });
	store.setHasNextPage({ hasNext: !!data.next });
	store.setTotalCount({ count: data.count });
}

export function useSoundSearch({
	query,
	commercialOnly,
}: {
	query: string;
	commercialOnly: boolean;
}) {
	// Only what is shown: the store also keeps unrelated state (the saved sounds, the scroll position).
	const { searchResults, isSearching, searchError, lastSearchQuery, currentPage, hasNextPage, isLoadingMore, totalCount } =
		useSoundsStore(useShallow((state) => ({
			searchResults: state.searchResults,
			isSearching: state.isSearching,
			searchError: state.searchError,
			lastSearchQuery: state.lastSearchQuery,
			currentPage: state.currentPage,
			hasNextPage: state.hasNextPage,
			isLoadingMore: state.isLoadingMore,
			totalCount: state.totalCount,
		})));
	const {
		setSearchResults,
		setSearching,
		setSearchError,
		setLastSearchQuery,
		setCurrentPage,
		setHasNextPage,
		setTotalCount,
		setLoadingMore,
		resetPagination,
	} = useSoundsStore.getState();
	const [attempt, setAttempt] = useState(0);

	const loadMore = async () => {
		if (isLoadingMore || !hasNextPage) return;

		try {
			setLoadingMore({ loading: true });
			setSearchError({ error: null });
			const nextPage = currentPage + 1;

			const searchParams = new URLSearchParams({
				page: nextPage.toString(),
				type: "effects",
			});

			if (query.trim()) {
				searchParams.set("q", query);
			}

			searchParams.set("commercial_only", commercialOnly.toString());
			const response = await fetch(
				`/api/sounds/search?${searchParams.toString()}`,
			);

			if (response.ok) {
				appendSoundsPage({ data: await response.json(), query, page: nextPage });
			} else {
				setSearchError({ error: `Load more failed: ${response.status}` });
			}
		} catch (err) {
			setSearchError({
				error: err instanceof Error ? err.message : "Load more failed",
			});
		} finally {
			setLoadingMore({ loading: false });
		}
	};

	useEffect(() => {
		if (!query.trim()) {
			setSearchResults({ results: [] });
			setSearchError({ error: null });
			setLastSearchQuery({ query: "" });
			return;
		}

		// Already searched (returning to the tab); a failed search leaves lastSearchQuery behind.
		if (query === lastSearchQuery) {
			return;
		}

		let ignore = false;

		const timeoutId = setTimeout(async () => {
			try {
				setSearching({ searching: true });
				setSearchError({ error: null });
				resetPagination();

				const response = await fetch(
					`/api/sounds/search?q=${encodeURIComponent(query)}&type=effects&page=1&commercial_only=${commercialOnly}`,
				);

				if (!ignore) {
					if (response.ok) {
						const data = await response.json();
						setSearchResults({ results: data.results });
						setLastSearchQuery({ query: query });
						setHasNextPage({ hasNext: !!data.next });
						setTotalCount({ count: data.count });
						setCurrentPage({ page: 1 });
					} else {
						// The results of the previous query are not results for this one.
						setSearchResults({ results: [] });
						setSearchError({ error: `Search failed: ${response.status}` });
					}
				}
			} catch (err) {
				if (!ignore) {
					setSearchResults({ results: [] });
					setSearchError({
						error: err instanceof Error ? err.message : "Search failed",
					});
				}
			} finally {
				if (!ignore) {
					setSearching({ searching: false });
				}
			}
		}, 300);

		return () => {
			clearTimeout(timeoutId);
			ignore = true;
		};
	}, [
		query,
		attempt,
		lastSearchQuery,
		setSearchResults,
		setSearching,
		setSearchError,
		setLastSearchQuery,
		setCurrentPage,
		setHasNextPage,
		setTotalCount,
		resetPagination,
	]);

	return {
		results: searchResults,
		isLoading: isSearching,
		error: searchError,
		/** Runs the failed search again. */
		retry: () => setAttempt((count) => count + 1),
		loadMore,
		hasNextPage,
		isLoadingMore,
		totalCount,
	};
}
