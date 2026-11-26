import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TProject, TProjectSettings } from "@/project/types";

export class UpdateProjectSettingsCommand extends Command {
	private savedSettings: Partial<TProjectSettings> | null = null;
	private savedUpdatedAt: Date | null = null;
	private savedFpsEditRevision: symbol | undefined;
	private readonly fpsEditRevision: symbol | undefined;

	constructor(
		private updates: Partial<TProjectSettings>,
		private settingsBeforePreview?: Partial<TProjectSettings>,
		explicitEdit = false,
	) {
		super();
		this.fpsEditRevision = explicitEdit && updates.fps ? Symbol() : undefined;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeProject = editor.project.getActive();
		if (!activeProject) return;

		const before = this.settingsBeforePreview
			? { ...activeProject.settings, ...this.settingsBeforePreview }
			: activeProject.settings;
		this.savedSettings = Object.fromEntries(
			(Object.keys(this.updates) as (keyof TProjectSettings)[]).map((key) => [key, before[key]]),
		);
		this.settingsBeforePreview = undefined;
		this.savedUpdatedAt = activeProject.metadata.updatedAt;

		const updatedProject: TProject = {
			...activeProject,
			settings: { ...activeProject.settings, ...this.updates },
			metadata: { ...activeProject.metadata, updatedAt: new Date() },
		};

		if (this.fpsEditRevision) {
			this.savedFpsEditRevision = editor.project.getFpsEditRevision();
			editor.project.setFpsEditRevision(this.fpsEditRevision);
		}
		editor.project.setActiveProject({ project: updatedProject });
		editor.save.markDirty();
	}

	undo(): void {
		if (!this.savedSettings || !this.savedUpdatedAt) return;
		const editor = EditorCore.getInstance();
		const activeProject = editor.project.getActive();
		if (!activeProject) return;

		const updatedProject: TProject = {
			...activeProject,
			settings: { ...activeProject.settings, ...this.savedSettings },
			metadata: { ...activeProject.metadata, updatedAt: this.savedUpdatedAt },
		};

		if (this.fpsEditRevision) editor.project.setFpsEditRevision(this.savedFpsEditRevision);
		editor.project.setActiveProject({ project: updatedProject });
		editor.save.markDirty();
	}
}
