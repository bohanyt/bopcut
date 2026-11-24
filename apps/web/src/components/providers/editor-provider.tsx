"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import { rendererDevice } from "@/services/renderer/renderer-device";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const { t } = useI18n();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<{ key: "projects.createFailed" | "projects.loadFailed"; detail?: string } | null>(null);
	const { setLoadingProject } = useKeybindingsStore();
	const getUntitledProjectName = useEffectEvent(() => t("editor.untitled"));

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			try {
				setIsLoading(true);
				void rendererDevice.start();
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: getUntitledProjectName(),
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError({ key: "projects.createFailed" });
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError({ key: "projects.loadFailed", detail: wasmPanic });
					} else {
						setError({ key: "projects.loadFailed", detail: err instanceof Error ? err.message : undefined });
					}
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
			if (editor.project.getActiveOrNull()?.metadata.id === projectId) {
				void editor.voiceOver.finishForNavigation();
			}
			if (editor.playback.getIsPlaying()) editor.playback.pause();
		};
	}, [projectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{t(error.key)}</p>
					{error.detail && <p className="text-muted-foreground text-sm">{localizeErrorDetail(error.detail, t)}</p>}
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">{t("editor.loadingProject")}</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">{t("editor.exitingProject")}</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const thumbnailSession = useEditor((e) => e.project.getIsLoading() ? null : e.project.getSession());
	const graphics = useSyncExternalStore(rendererDevice.subscribe, rendererDevice.getSnapshot, rendererDevice.getSnapshot);
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		if (thumbnailSession !== null && graphics.state === "ready") {
			void editor.project.ensureThumbnail({ session: thumbnailSession });
		}
	}, [editor, thumbnailSession, graphics.state]);

	// Leaving the page with unsaved changes is guarded by the save manager itself (also after the editor
	// page is gone, while a closed project's last changes are written).

	useEditorActions();
	useKeybindingsListener();
	return null;
}
