import { Command, type CommandContext, type CommandResult } from "./base-command";
import { EditorCore } from "@/core";

export class BatchCommand extends Command {
	// Ripple is applied per child below, so children that opt out (compound create/ungroup)
	// stay exempt, also inside nested batches.
	override readonly ripples = false;

	constructor(private commands: Command[]) {
		super();
	}

	execute(context = this.getContext()): CommandResult | undefined {
		return this.runAll(context, (command) => command.execute(context));
	}

	undo(): void {
		for (const command of [...this.commands].reverse()) {
			command.undo();
		}
	}

	redo(context = this.getContext()): CommandResult | undefined {
		return this.runAll(context, (command) => command.redo(context));
	}

	private getContext(): CommandContext {
		return { rippleEnabled: EditorCore.getInstance().command.isRippleEnabled };
	}

	// All or nothing: if one command throws (e.g. a compound cycle), the earlier ones are undone.
	private runAll(
		context: CommandContext,
		run: (command: Command) => CommandResult | undefined,
	): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;
		const done: Command[] = [];

		const editor = EditorCore.getInstance();
		try {
			for (const command of this.commands) {
				const beforeTracks =
					context.rippleEnabled && command.ripples
						? (editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
						: null;
				const result = run(command);
				if (result?.changed === false) continue;
				done.push(command);
				editor.command.applyRipple({ beforeTracks });
				if (result?.selection !== undefined) {
					latestSelectionResult = result;
				}
			}
		} catch (error) {
			for (const command of done.reverse()) {
				command.undo();
			}
			throw error;
		}

		return done.length > 0 ? latestSelectionResult : { changed: false };
	}
}
