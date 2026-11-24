import type { EditorCore } from "@/core";
import type { MediaImportSession } from "@/core/managers/media-manager";
import { getBrowserTranslator } from "@/i18n/browser";
import { en } from "@/i18n/en";
import { id } from "@/i18n/id";
import type { MediaTime } from "@/wasm";
import { mediaTimeFromSeconds } from "@/wasm";
import { isTimelineGestureActive } from "@/timeline/gesture-state";
import { downloadBlob } from "@/utils/browser";
import { toast } from "sonner";
import { Microphone, microphoneError, type MicrophoneInput, type OpenMicrophone } from "./microphone";
import { findUneditedTake, PlaceTakeCommand, placeTake, type PlacedTake, type TakeAsset } from "./take-placement";
import { alignedStartFrame, trimPcmStart, wavParts } from "./wav";

type Preferences = { deviceId: string; muteProject: boolean; noiseSuppression: boolean };
type Scope = MediaImportSession & { sceneId: string };
type Session = { scope: Scope; startTime: MediaTime; takes: TakeAsset[]; anchors: PlacedTake[] };
type PendingTake = { session: Session; file: File; duration: MediaTime; silent: boolean; name: string; asset?: TakeAsset; saving?: Promise<void> };
type Phase = "idle" | "setup" | "count-in" | "starting" | "recording" | "saving" | "review" | "recovery";
type ErrorKey = ReturnType<typeof microphoneError>;

type Snapshot = {
	phase: Phase;
	preferences: Preferences;
	devices: MediaDeviceInfo[];
	ready: boolean;
	error: ErrorKey | null;
	count: number;
	startedAt: number;
	takes: TakeAsset[];
	activeTake?: string;
};

const key = "opencut-voice-over";
const recoveryToast = "voice-over-recovery";
const initialPreferences: Preferences = { deviceId: "", muteProject: true, noiseSuppression: false };
const initialSnapshot: Snapshot = {
	phase: "idle", preferences: initialPreferences, devices: [], ready: false, error: null,
	count: 3, startedAt: 0, takes: [],
};

function readPreferences(): Preferences {
	try {
		const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
		return {
			deviceId: typeof stored.deviceId === "string" ? stored.deviceId : "",
			muteProject: stored.muteProject !== false,
			noiseSuppression: stored.noiseSuppression === true,
		};
	} catch {
		return initialPreferences;
	}
}

export class VoiceOver {
	private state = initialSnapshot;
	private listeners = new Set<() => void>();
	private levelListeners = new Set<(level: number) => void>();
	private captureScope: Scope | null = null;
	private mic: MicrophoneInput | null = null;
	private opening: AbortController | null = null;
	private timer?: ReturnType<typeof setTimeout>;
	private releaseMute?: () => void;
	private session: Session | null = null;
	private trimFrames = 0;
	private pending: PendingTake | null = null;
	private finishing: Promise<void> | null = null;
	private preferredTracks = new Map<string, string>();
	private unsubscribers: (() => void)[];
	private guardAttached = false;
	private disposed = false;

	constructor(
		private editor: EditorCore,
		private openMicrophone: OpenMicrophone = Microphone.open,
		private countInMs = 1000,
		private saveTimeoutMs = 20_000,
	) {
		this.unsubscribers = [
			editor.playback.onPlaybackInterrupt(() => {
				if (this.isCapturing()) void this.stop();
			}),
			editor.scenes.subscribe(this.scopeChanged),
			editor.project.subscribe(this.scopeChanged),
		];
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	subscribeLevel = (listener: (level: number) => void) => {
		this.levelListeners.add(listener);
		return () => { this.levelListeners.delete(listener); };
	};

	getSnapshot = () => this.state;
	getServerSnapshot = () => initialSnapshot;

	isCapturing(): boolean {
		return ["count-in", "starting", "recording"].includes(this.state.phase);
	}

	toggle(): void {
		if (this.isCapturing()) void this.stop();
		else if (this.state.phase === "setup") this.closeSetup();
		else if (this.state.phase === "idle" || this.state.phase === "review") this.openSetup();
	}

	openSetup(): void {
		const scope = this.getScope();
		if (!scope || this.pending || this.finishing) return;
		this.session = null;
		this.captureScope = scope;
		this.update({ phase: "setup", preferences: readPreferences(), takes: [], activeTake: undefined });
		void this.connect();
	}

	closeSetup(): void {
		if (this.state.phase === "setup") this.leaveCapture();
	}

	changePreferences(change: Partial<Preferences>): void {
		if (this.state.phase !== "setup") return;
		const preferences = { ...this.state.preferences, ...change };
		this.update({ preferences });
		try {
			localStorage.setItem(key, JSON.stringify(preferences));
		} catch {
			// Recording also works when browser storage is blocked.
		}
		if (change.deviceId !== undefined || change.noiseSuppression !== undefined) void this.connect();
	}

	retryMicrophone(): void {
		if (this.state.phase === "setup") void this.connect();
	}

	record(): void {
		if (this.state.phase !== "setup" || !this.state.ready || !this.captureScope) return;
		this.session = {
			scope: this.captureScope, startTime: this.editor.playback.getCurrentTime(), takes: [], anchors: [],
		};
		this.beginCountIn();
	}

	retake(): void {
		if (this.state.phase !== "review" || !this.session || !this.isCurrent(this.session.scope)) return;
		this.captureScope = this.session.scope;
		this.editor.playback.pause();
		this.editor.playback.seek({ time: this.session.startTime });
		this.editor.playback.revealPlayhead();
		this.update({ phase: "count-in", count: 3, ready: false, error: null });
		void this.connect().then(() => {
			if (this.state.phase === "count-in" && this.mic) this.beginCountIn();
		});
	}

	swap(mediaId: string): void {
		const session = this.session;
		if (this.state.phase !== "review" || !session || !this.isCurrent(session.scope)) return;
		const take = session.takes.find((asset) => asset.mediaId === mediaId);
		if (!take || this.state.activeTake === mediaId) return;
		try {
			this.insert(session, take);
			this.updateReview();
		} catch {
			toast.error(getBrowserTranslator()("recording.swapFailed"));
		}
	}

	done(): void {
		if (this.state.phase !== "review") return;
		this.session = null;
		this.update({ phase: "idle", takes: [], activeTake: undefined });
	}

	stop(): Promise<void> | null {
		if (this.state.phase === "count-in" || this.state.phase === "starting") {
			this.leaveCapture();
			return null;
		}
		if (this.finishing) return this.finishing;
		if (this.state.phase !== "recording" || !this.mic || !this.session) return null;
		const mic = this.mic;
		const session = this.session;
		const trimFrames = this.trimFrames;
		this.update({ phase: "saving" });
		const finishing = this.finished(mic, session, trimFrames);
		this.finishing = finishing;
		void finishing.finally(() => {
			if (this.finishing === finishing) this.finishing = null;
		});
		return finishing;
	}

	finishForNavigation(): Promise<void> | null {
		this.closeSetup();
		return this.stop();
	}

	canRetry(): boolean {
		const scope = this.pending?.session.scope;
		const current = this.getScope();
		return !!scope && !this.pending?.silent && current?.projectId === scope.projectId && current.sceneId === scope.sceneId;
	}

	async retryTake(): Promise<void> {
		const pending = this.pending;
		const scope = this.getScope();
		if (this.state.phase !== "recovery" || !this.canRetry() || !pending || !scope) return;
		pending.session.scope = scope;
		this.update({ phase: "saving" });
		toast.dismiss(recoveryToast);
		const finishing = this.saveTake(pending);
		this.finishing = finishing;
		try {
			await finishing;
		} finally {
			if (this.finishing === finishing) this.finishing = null;
		}
	}

	saveWav = (): void => {
		if (this.state.phase !== "recovery" || !this.pending) return;
		const { file } = this.pending;
		downloadBlob({ blob: file, filename: file.name });
		this.pending = null;
		toast.dismiss(recoveryToast);
		this.leaveCapture();
	};

	dispose(): void {
		this.disposed = true;
		this.unsubscribers.forEach((unsubscribe) => unsubscribe());
		this.leaveCapture();
	}

	private async connect(): Promise<void> {
		this.disconnect();
		const opening = new AbortController();
		this.opening = opening;
		const { signal } = opening;
		this.update({ ready: false, error: null });
		const options = this.state.preferences;
		const open = (deviceId: string) => this.openMicrophone(
			{ deviceId, noiseSuppression: options.noiseSuppression }, signal,
			(peak) => { if (!signal.aborted) this.levelListeners.forEach((fn) => fn(peak)); },
			() => { if (!signal.aborted) this.microphoneLost(); },
		);
		try {
			const mic = await open(options.deviceId).catch((error) => {
				// A previously selected input may have been unplugged while the editor was closed.
				if (!signal.aborted && options.deviceId && microphoneError(error) === "recording.noMicrophone") return open("");
				throw error;
			});
			if (signal.aborted) return mic.close();
			this.mic = mic;
			// Device names become available after opening the stream.
			const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []);
			if (signal.aborted) return;
			this.update({ ready: true, devices: (devices ?? []).filter(({ kind }) => kind === "audioinput"),
				preferences: { ...this.state.preferences, deviceId: options.deviceId && mic.deviceId === options.deviceId ? mic.deviceId : "" },
			});
		} catch (error) {
			if (signal.aborted) return;
			const message = microphoneError(error);
			if (this.state.phase === "setup") this.update({ ready: false, error: message });
			else {
				toast.error(getBrowserTranslator()(message));
				this.leaveCapture();
			}
		}
	}

	private beginCountIn(): void {
		if (this.editor.playback.getIsPlaying()) this.editor.playback.pause();
		this.update({ phase: "count-in", count: 3 });
		const tick = () => {
			if (this.state.phase !== "count-in") return;
			if (this.state.count === 1) this.startCapture();
			else {
				this.update({ count: this.state.count - 1 });
				this.timer = setTimeout(tick, this.countInMs);
			}
		};
		this.timer = setTimeout(tick, this.countInMs);
	}

	private startCapture(): void {
		const mic = this.mic;
		const session = this.session;
		if (!mic || !session || !this.isCurrent(session.scope)) return this.leaveCapture();
		this.update({ phase: "starting" });
		this.timer = setTimeout(() => {
			toast.error(getBrowserTranslator()("recording.silentStart"));
			this.leaveCapture();
		}, 5000);
		mic.start((firstFrame) => {
			if (this.state.phase !== "starting" || this.mic !== mic) return;
			clearTimeout(this.timer);
			const { playback } = this.editor;
			if (this.state.preferences.muteProject) this.releaseMute = playback.muteDuringRecording();
			const shouldPlay = playback.getCurrentTime() === session.startTime &&
				session.startTime < this.editor.timeline.getTotalDuration();
			const audible = shouldPlay && playback.getOutputVolume() > 0;
			const cueTime = mic.getTime();
			if (shouldPlay) playback.play({ restartAtEnd: false });
			this.trimFrames = Math.max(0, alignedStartFrame({
				playbackTime: cueTime, sampleRate: mic.sampleRate, inputLatency: mic.inputLatency,
				outputLatency: audible ? mic.outputLatency : 0,
			}) - firstFrame);
			this.update({ phase: "recording", startedAt: performance.now() });
		});
	}

	private async finished(mic: MicrophoneInput, session: Session, trimFrames: number) {
		const closing = mic.stop();
		if (this.isCurrent(session.scope) && this.editor.playback.getIsPlaying()) this.editor.playback.pause();
		this.unmute();
		const { chunks: captured, complete } = await closing;
		const chunks = trimPcmStart(captured, trimFrames);
		this.disconnect();
		if (this.disposed) return;
		if (!complete) toast.warning(getBrowserTranslator()("recording.incompleteTake"), { duration: 10_000 });
		const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
		const duration = mediaTimeFromSeconds({ seconds: frames / mic.sampleRate });
		if (duration <= 0) {
			toast.error(getBrowserTranslator()("recording.emptyTake"));
			this.leaveCapture();
			return;
		}
		const name = this.nextName();
		const file = new File(wavParts(chunks, mic.sampleRate), `${name}.wav`, { type: "audio/wav" });
		const silent = !chunks.some((chunk) => chunk.some((sample) => Math.abs(sample) > 2));
		const pending = { session, file, duration, silent, name };
		this.pending = pending;
		if (silent) {
			this.recover("recording.silentTake");
			return;
		}
		await this.saveTake(pending);
	}

	private async saveTake(pending: PendingTake): Promise<void> {
		try {
			const { session, file, name, duration } = pending;
			if (!this.isCurrent(session.scope)) return this.recover("recording.takeInMemory");
			if (!pending.asset || !this.editor.media.getAssets().some(({ id }) => id === pending.asset?.mediaId)) {
				// A retry waits for a write that is still running, so a slow upload is stored once.
				const saving = pending.saving ??= this.editor.media
					.importFile({ session: session.scope, file, name, ratchetFps: false })
					.then((asset) => {
						if (asset) pending.asset = { mediaId: asset.id, name: asset.name, duration };
					})
					.finally(() => { pending.saving = undefined; });
				// Storage that never answers must not hold the WAV or block leaving the project.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.saveTimeoutMs + file.size / 4096);
				});
				try {
					await Promise.race([saving, deadline]);
				} finally {
					clearTimeout(timer);
					void saving.catch(() => {});
				}
				if (!pending.asset) return this.recover("recording.saveFailed");
			}
			if (this.disposed) return;
			if (!this.isCurrent(session.scope)) return this.recover("recording.takeInMemory");
			this.insert(session, pending.asset);
			session.takes.push(pending.asset);
			this.pending = null;
			this.captureScope = null;
			this.session = session;
			this.updateReview();
			this.editor.playback.revealPlayhead();
		} catch {
			this.recover("recording.saveFailed");
		}
	}

	private insert(session: Session, take: TakeAsset): void {
		if (this.editor.timeline.isPreviewActive() || isTimelineGestureActive()) {
			throw new Error("A timeline gesture is in progress");
		}
		const before = this.editor.scenes.getActiveScene().tracks;
		const scopeKey = JSON.stringify([session.scope.projectId, session.scope.sceneId]);
		if (!this.editor.media.getAssets().some(({ id }) => id === take.mediaId)) throw new Error("Take media unavailable");
		const placement = placeTake({
			tracks: before, take, startTime: session.startTime, candidates: session.anchors,
			preferredTrackId: this.preferredTracks.get(scopeKey),
		});
		if (!placement) throw new Error("Could not place take");
		const { trackId, element } = placement.anchor;
		this.editor.command.execute({ command: new PlaceTakeCommand({
			before, after: placement.tracks,
			selectedElements: [{ trackId, elementId: element.id }],
		}) });
		// Discard replacement candidates from earlier spots that were edited by the user.
		session.anchors = [placement.anchor, ...session.anchors.filter((anchor) => anchor.element.id === element.id)];
		this.preferredTracks.set(scopeKey, trackId);
	}

	private updateReview(): void {
		if (!this.session) return;
		const tracks = this.editor.scenes.getActiveScene().tracks;
		this.update({
			phase: "review", takes: [...this.session.takes],
			activeTake: findUneditedTake(tracks, this.session.anchors)?.element.mediaId,
		});
	}

	private recover(message: "recording.saveFailed" | "recording.takeInMemory" | "recording.silentTake"): void {
		if (this.disposed) return;
		this.captureScope = null;
		this.update({ phase: "recovery", error: message });
		const t = getBrowserTranslator();
		toast.error(t(message), {
			id: recoveryToast, duration: Infinity, position: "top-right",
			action: { label: t("recording.saveWav"), onClick: this.saveWav },
		});
	}

	private nextName(): string {
		const assets = this.editor.media.getAssets();
		const names = new Set(assets.flatMap(({ name }) => [name.toLowerCase(), name.replace(/\.wav$/i, "").toLowerCase()]));
		const t = getBrowserTranslator();
		let number = 1;
		while ([en, id].some((dictionary) => names.has(dictionary["recording.assetName"].replace("{number}", String(number)).toLowerCase()))) number++;
		return t("recording.assetName", { number });
	}

	private microphoneLost = (): void => {
		const t = getBrowserTranslator();
		if (this.state.phase === "recording") {
			toast.warning(t("recording.disconnected"));
			void this.stop();
		} else if (this.state.phase === "setup") {
			this.disconnect();
			this.update({ ready: false, error: "recording.disconnectedSetup" });
		} else if (this.isCapturing()) {
			toast.error(t("recording.disconnectedSetup"));
			this.leaveCapture();
		}
	};

	private scopeChanged = (): void => {
		if (this.captureScope && !this.isCurrent(this.captureScope)) {
			this.closeSetup();
			void this.stop();
		}
		if (this.state.phase !== "review" || !this.session) return;
		if (!this.isCurrent(this.session.scope)) return this.done();
		const activeTake = findUneditedTake(this.editor.scenes.getActiveScene().tracks, this.session.anchors)?.element.mediaId;
		if (activeTake !== this.state.activeTake) this.update({ activeTake });
	};

	private getScope(): Scope | null {
		const session = this.editor.media.startImport();
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		return session && sceneId ? { ...session, sceneId } : null;
	}

	private isCurrent(scope: Scope): boolean {
		return !scope.signal.aborted &&
			scope.signal === this.editor.project.getSessionSignal() &&
			scope.sceneId === this.editor.scenes.getActiveSceneOrNull()?.id &&
			this.editor.project.canImportMedia(scope.projectId);
	}

	private leaveCapture(): void {
		clearTimeout(this.timer);
		this.disconnect();
		this.unmute();
		this.captureScope = null;
		if (this.session?.takes.length && this.isCurrent(this.session.scope)) this.updateReview();
		else {
			this.session = null;
			this.update({ phase: "idle", ready: false, error: null, takes: [], activeTake: undefined });
		}
	}

	private disconnect(): void {
		this.opening?.abort();
		this.opening = null;
		this.mic?.close();
		this.mic = null;
		this.levelListeners.forEach((fn) => fn(0));
	}

	private unmute(): void {
		this.releaseMute?.();
		this.releaseMute = undefined;
	}

	private beforeUnload = (event: BeforeUnloadEvent) => {
		event.preventDefault();
		(event as unknown as { returnValue: string }).returnValue = "";
	};

	private update(change: Partial<Snapshot>): void {
		this.state = { ...this.state, ...change };
		const guard = !this.disposed && ["starting", "recording", "saving", "recovery"].includes(this.state.phase);
		if (typeof window !== "undefined" && this.guardAttached !== guard) {
			this.guardAttached = guard;
			if (guard) window.addEventListener("beforeunload", this.beforeUnload);
			else window.removeEventListener("beforeunload", this.beforeUnload);
		}
		this.listeners.forEach((fn) => fn());
	}
}
