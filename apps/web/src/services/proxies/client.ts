"use client";
import { create } from "zustand";
import { useEffect } from "react";
import type { EditorCore } from "@/core";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { ProxyInfo, ProxyUpdate } from "./mapping";

type Preferences = { enabled?: boolean; software: boolean };
const settingsKey = "bopencut-scrub-proxies";
function preferences(): Preferences {
	try { return { software: false, ...JSON.parse(localStorage.getItem(settingsKey) ?? "{}") }; }
	catch { return { software: false }; }
}
type State = {
	settings: Preferences;
	update?: ProxyUpdate;
	ready: Map<string, { info: ProxyInfo; file: File }>;
	save: (settings: Preferences) => void;
	clear: () => Promise<void>;
};
export const useProxyStore = create<State>((set, get) => ({
	settings: typeof window === "undefined" ? { software: false } : preferences(),
	ready: new Map(),
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
			const chunk = 64 * 1024;
			const pieces = await Promise.all([0, Math.max(0, Math.floor((file.size - chunk) / 2)), Math.max(0, file.size - chunk)]
				.map(start => file.slice(start, start + chunk).arrayBuffer()));
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
		const controller = new AbortController();
		const id = crypto.randomUUID();
		const paused = () => editor.renderer.isExportRunning() ||
			["count-in", "starting", "recording"].includes(editor.voiceOver.getSnapshot().phase);
		let queue = mediaOrder(editor);
		let isPaused = paused();
		let files = new Map(editor.media.getAssets().map(asset => [asset.id, asset.file]));
		useProxyStore.setState({ ready: new Map(), update: undefined });
		const post = (body: object) => fetch("/api/proxies", {
			method: "POST", body: JSON.stringify({ id, ...body }), signal: controller.signal,
			headers: { "Content-Type": "application/json" },
		});
		let opened = false;
		const refresh = () => {
			if (!opened) return;
			const next = mediaOrder(editor);
			const state = paused();
			const updatedFiles = new Map(editor.media.getAssets().map(asset => [asset.id, asset.file]));
			const replaced = next.filter(id => updatedFiles.get(id) !== files.get(id));
			files = updatedFiles;
			if (state === isPaused && next.join() === queue.join() && !replaced.length) return;
			queue = next;
			isPaused = state;
			void post({ action: "update", ids: queue, paused: isPaused, replaced }).catch(() => {});
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
						const update: ProxyUpdate = JSON.parse(buffer.slice(0, end));
						buffer = buffer.slice(end + 1);
						if (controller.signal.aborted) return;
						useProxyStore.setState({ update });
						const media = update.media;
						const file = editor.media.getAssets().find(asset => asset.id === media?.id)?.file;
						if (media && file) void fingerprint(file).then(async hash => {
							if (controller.signal.aborted || !media.info.key.startsWith(hash + "-")) return;
							const source = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: 1024 * 1024 }) });
							try {
								const track = await source.getPrimaryVideoTrack();
								if (!track || track.displayWidth !== media.info.width || track.displayHeight !== media.info.height ||
									Math.abs(await track.getFirstTimestamp() - media.info.source[0]) > 0.000002) return;
							} finally { source.dispose(); }
							if (controller.signal.aborted) return;
							useProxyStore.setState(state => ({ ready: new Map(state.ready).set(media.id, { info: media.info, file }) }));
						}).catch(() => {});
					}
				}
			} finally { await reader.cancel().catch(() => {}); }
		})().catch(() => {});
		let scrubbing = editor.playback.getIsScrubbing();
		const dispose = [editor.timeline.subscribe(refresh), editor.scenes.subscribe(refresh), editor.media.subscribe(refresh),
			editor.renderer.subscribe(refresh), editor.voiceOver.subscribe(refresh),
			editor.playback.subscribeState(() => {
				const next = editor.playback.getIsScrubbing();
				if (scrubbing && !next) refresh();
				scrubbing = next;
			})];
		const syncSettings = (event: StorageEvent) => {
			if (event.key === settingsKey) useProxyStore.setState({ settings: preferences() });
		};
		window.addEventListener("storage", syncSettings);
		return () => { controller.abort(); dispose.forEach(fn => fn()); window.removeEventListener("storage", syncSettings); };
	}, [editor, project, settings]);
}
