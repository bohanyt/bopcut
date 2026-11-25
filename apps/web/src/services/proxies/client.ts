"use client";
import { create } from "zustand";
import { useEffect } from "react";
import type { EditorCore } from "@/core";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { ProxyInfo, ProxyUpdate } from "./mapping";
import { proxyFingerprintRegions, proxyProfile } from "./identity";

type Preferences = { enabled?: boolean; software: boolean; retry?: number };
const settingsKey = "bopencut-scrub-proxies";
function preferences(): Preferences {
	try { return { software: false, ...JSON.parse(localStorage.getItem(settingsKey) ?? "{}") }; }
	catch { return { software: false }; }
}
type State = {
	settings: Preferences;
	update?: ProxyUpdate;
	ready: Map<string, { info: ProxyInfo; file: File }>;
	missing?: { key: string; ids: string[] };
	save: (settings: Preferences) => void;
	clear: () => Promise<void>;
	invalidate: (key: string, retry?: boolean) => void;
};
export const useProxyStore = create<State>((set, get) => ({
	settings: typeof window === "undefined" ? { software: false } : preferences(),
	ready: new Map(),
	invalidate(key, retry = true) {
		const ready = new Map(get().ready);
		const ids = [...ready].filter(([, proxy]) => proxy.info.key === key).map(([id]) => id);
		if (!ids.length) return;
		for (const id of ids) ready.delete(id);
		set({ ready, ...(retry ? { missing: { key, ids } } : {}) });
	},
	save(settings) { localStorage.setItem(settingsKey, JSON.stringify(settings)); set({ settings }); },
	async clear() {
		const response = await fetch("/api/proxies", { method: "DELETE" });
		if (response.ok) {
			get().save({ ...get().settings, enabled: false });
			set({ ready: new Map(), update: undefined });
		}
	},
}));

const hashes = new WeakMap<File, Promise<string>>();
function fingerprint(file: File) {
	let cached = hashes.get(file);
	if (!cached) {
		cached = (async () => {
			const pieces = proxyFingerprintRegions(file.size).map(({ start, end }) => file.slice(start, end));
			const data = await new Blob([String(file.size), ...pieces]).arrayBuffer();
			const sha = await crypto.subtle.digest("SHA-256", data);
			return Array.from(new Uint8Array(sha), x => x.toString(16).padStart(2, "0")).join("");
		})();
		hashes.set(file, cached);
	}
	return cached;
}

function mediaOrder(editor: EditorCore) {
	const active = editor.scenes.getActiveSceneOrNull();
	const scenes = editor.scenes.getScenes();
	const time = editor.playback.getCurrentTime();
	const positions = new Map<string, number>();
	function collect(id: string, distance: number | undefined, ancestors: Set<string>) {
		if (ancestors.has(id)) return;
		const scene = scenes.find(scene => scene.id === id);
		if (!scene) return;
		const next = new Set([...ancestors, id]);
		for (const track of [scene.tracks.main, ...scene.tracks.overlay]) {
			for (const clip of track.elements) {
				const gap = distance ?? Math.max(clip.startTime - time, time - clip.startTime - clip.duration, 0);
				if (clip.type === "video") positions.set(clip.mediaId, Math.min(gap, positions.get(clip.mediaId) ?? Infinity));
				if (clip.type === "compound") collect(clip.sceneId, gap, next);
			}
		}
	}
	if (active) collect(active.id, undefined, new Set());
	for (const scene of scenes) if (scene.kind !== "compound" && scene !== active) collect(scene.id, Infinity, new Set());
	const present = new Set(editor.media.getAssets().map(asset => asset.id));
	return [...positions].filter(([id]) => present.has(id)).sort((a, b) => a[1] - b[1]).map(([id]) => id);
}
export function useProxySession(editor: EditorCore, project: string) {
	const settings = useProxyStore(state => state.settings);
	useEffect(() => {
		const syncSettings = (event: StorageEvent) => {
			if (event.key === settingsKey) useProxyStore.setState({ settings: preferences() });
		};
		window.addEventListener("storage", syncSettings);
		return () => window.removeEventListener("storage", syncSettings);
	}, []);
	useEffect(() => {
		useProxyStore.setState({ ready: new Map(), update: undefined, missing: undefined });
		if (settings.enabled === false) return;
		const controller = new AbortController();
		const id = crypto.randomUUID();
		const paused = () => editor.renderer.isExportRunning() ||
			["count-in", "starting", "recording"].includes(editor.voiceOver.getSnapshot().phase);
		let queue = mediaOrder(editor);
		let isPaused = paused();
		let files = new Map(editor.media.getAssets().map(asset => [asset.id, asset.file]));
		const post = (body: object) => fetch("/api/proxies", {
			method: "POST", body: JSON.stringify({ id, ...body }), signal: controller.signal,
			headers: { "Content-Type": "application/json" },
		});
		let opened = false;
		const evicted = new Map<string, string[]>();
		const announced = new Map<string, string>();
		const rejected = new Map<string, number>();
		let sequence = 0;
		let readerRequestedAt = 0;
		const pendingReplaced = new Map<string, number>();
		function update(replaced: string[]) {
			const current = ++sequence;
			for (const id of replaced) pendingReplaced.set(id, current);
			const pending = [...pendingReplaced];
			void post({ action: "update", sequence: current, ids: queue, paused: isPaused,
				replaced: pending.map(([id]) => id) }).then(response => {
				if (!response.ok) return;
				for (const [id, revision] of pending) {
					if (pendingReplaced.get(id) === revision) pendingReplaced.delete(id);
				}
			}).catch(() => {});
		}
		const refresh = (allowReaderRecheck = false) => {
			if (!opened) return;
			const next = mediaOrder(editor);
			const state = paused();
			const updatedFiles = new Map(editor.media.getAssets().map(asset => [asset.id, asset.file]));
			const replaced = next.filter(id => updatedFiles.get(id) !== files.get(id));
			const previous = useProxyStore.getState().ready;
			const ready = new Map([...previous].filter(([id, proxy]) => next.includes(id) && updatedFiles.get(id) === proxy.file));
			if (ready.size !== previous.size) useProxyStore.setState({ ready });
			files = updatedFiles;
			const retry: string[] = [];
			for (const [key, ids] of evicted) {
				if (ids.includes(next[0]) && !state && Date.now() - (rejected.get(key) ?? 0) > 10_000) {
					retry.push(next[0]);
					evicted.delete(key);
				}
			}
			const readerRecheck = allowReaderRecheck && useProxyStore.getState().update?.state === "readonly" &&
				Date.now() - readerRequestedAt >= 60_000;
			if (readerRecheck) readerRequestedAt = Date.now();
			if (!readerRecheck && state === isPaused && next.join() === queue.join() && !replaced.length && !retry.length) return;
			queue = next;
			isPaused = state;
			update([...replaced, ...retry]);
		};
		void (async () => {
			const response = await post({ project, ids: queue, paused: isPaused, ...settings });
			if (!response.ok || !response.body) return;
			opened = true;
			refresh();
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					let end: number;
					while ((end = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, end);
						buffer = buffer.slice(end + 1);
						if (!line) continue;
						const update: ProxyUpdate = JSON.parse(line);
						if (controller.signal.aborted) return;
						if (update.state === "readonly" && useProxyStore.getState().update?.state !== "readonly") {
							readerRequestedAt = Date.now();
						}
						useProxyStore.setState({ update });
						if (update.evicted) {
							evicted.set(update.evicted, [...announced]
								.filter(([, key]) => key === update.evicted).map(([id]) => id));
							useProxyStore.getState().invalidate(update.evicted, false);
						}
						const media = update.media;
						const file = editor.media.getAssets().find(asset => asset.id === media?.id)?.file;
						if (media) {
							announced.set(media.id, media.info.key);
							evicted.delete(media.info.key);
						}
						if (media && file) void fingerprint(file).then(async hash => {
							if (controller.signal.aborted || media.info.key !== hash + "-" + proxyProfile) return;
							const source = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: 1024 * 1024 }) });
							try {
								const track = await source.getPrimaryVideoTrack();
								if (!track || track.displayWidth !== media.info.width || track.displayHeight !== media.info.height ||
									Math.abs(await track.getFirstTimestamp() - media.info.source[0]) > 0.000002) return;
							} finally { source.dispose(); }
							if (controller.signal.aborted || files.get(media.id) !== file || !queue.includes(media.id) ||
								evicted.has(media.info.key)) return;
							useProxyStore.setState(state => ({ ready: new Map(state.ready).set(media.id, { info: media.info, file }) }));
						}).catch(() => {});
					}
				}
			} finally { await reader.cancel().catch(() => {}); }
		})().catch(() => {});
		let scrubbing = editor.playback.getIsScrubbing();
		const onVisible = () => { if (!document.hidden) refresh(true); };
		document.addEventListener("visibilitychange", onVisible);
		const refreshQueue = () => refresh();
		const dispose = [editor.timeline.subscribe(refreshQueue), editor.scenes.subscribe(refreshQueue), editor.media.subscribe(() => refresh(true)),
			editor.renderer.subscribe(refreshQueue), editor.voiceOver.subscribe(refreshQueue),
			useProxyStore.subscribe((state, previous) => {
				const missing = state.missing;
				if (!opened || !missing || missing === previous.missing) return;
				evicted.set(missing.key, missing.ids);
				if (Date.now() - (rejected.get(missing.key) ?? 0) <= 10_000) return;
				rejected.set(missing.key, Date.now());
				update(missing.ids);
			}),
			editor.playback.subscribeState(() => {
				const next = editor.playback.getIsScrubbing();
				if (scrubbing && !next) refresh();
				if (!scrubbing && next) refresh(true);
				scrubbing = next;
			})];
		return () => { controller.abort(); document.removeEventListener("visibilitychange", onVisible); dispose.forEach(fn => fn()); };
	}, [editor, project, settings]);
}
