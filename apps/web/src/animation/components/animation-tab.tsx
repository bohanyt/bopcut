// In and out animation presets for a clip. They are written as ordinary keyframes, so the result can be
// edited on the timeline afterwards; choosing a preset again replaces only the preset's own keyframes.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	ANIMATION_IN_TYPES,
	ANIMATION_OUT_TYPES,
	DEFAULT_IN_SECONDS,
	DEFAULT_OUT_SECONDS,
	type AnimationPresetRequest,
	applyAnimationPresets,
	readAnimationPresets,
} from "@/animation/presets";
import type { TimelineElement } from "@/timeline";

const LABELS: Record<string, string> = {
	none: "None",
	fade: "Fade",
	pop: "Pop",
	impact: "Impact",
	blur: "Blur",
	typewriter: "Typewriter",
	fall: "Fall",
	dissolve: "Dissolve",
};

function PresetSide({
	side,
	element,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	onApply: (request: AnimationPresetRequest) => void;
}) {
	const current = readAnimationPresets(element)[side];
	const types = (side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES).filter(
		(type) => type !== "typewriter" || element.type === "text",
	);
	const type = current?.type ?? "none";
	const [duration, setDuration] = useState(current ? String(current.duration) : "");
	useEffect(() => setDuration(current ? String(current.duration) : ""), [current?.duration]);
	const apply = (nextType: string, seconds?: number) =>
		onApply({ [side]: { type: nextType, ...(seconds ? { duration: seconds } : {}) } } as AnimationPresetRequest);
	return (
		<>
			<SectionField label={side === "in" ? "In" : "Out"}>
				<Select value={type} onValueChange={(next) => apply(next)}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["none", ...types].map((option) => (
							<SelectItem key={option} value={option}>
								{LABELS[option] ?? option}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SectionField>
			{current && (
				<SectionField label="Length">
					<NumberField
						value={duration}
						suffix="s"
						onChange={(event) => setDuration(event.target.value)}
						onBlur={() => {
							const seconds = Number.parseFloat(duration);
							if (Number.isFinite(seconds) && seconds > 0 && seconds <= 10 && seconds !== current.duration) apply(type, seconds);
							// Shows the length the clip has now (a length that does not fit is shortened).
							setDuration(String(current.duration));
						}}
						onReset={() =>
							apply(type, side === "in" ? DEFAULT_IN_SECONDS[type as keyof typeof DEFAULT_IN_SECONDS] : DEFAULT_OUT_SECONDS[type as keyof typeof DEFAULT_OUT_SECONDS])
						}
					/>
				</SectionField>
			)}
		</>
	);
}

export function AnimationTab({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	const editor = useEditor();
	const canvasHeight = useEditor(
		(e) => e.project.getActiveOrNull()?.settings.canvasSize.height ?? 1080,
	);
	const onApply = (request: AnimationPresetRequest) => {
		let next: TimelineElement;
		try {
			next = applyAnimationPresets(element, request, { canvasHeight });
		} catch (error) {
			toast.error("Animation not applied", { description: error instanceof Error ? error.message : String(error) });
			return;
		}
		const effectsOf = (el: TimelineElement) => (el as { effects?: unknown }).effects;
		// Nothing changed (for example a length that does not fit, shortened to the one it has): no undo step.
		if (JSON.stringify(next.animations ?? null) === JSON.stringify(element.animations ?? null) && effectsOf(next) === effectsOf(element)) return;
		// One edit, so one undo.
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { animations: next.animations, ...("effects" in next ? { effects: (next as { effects?: unknown }).effects } : {}) } as Partial<TimelineElement>,
				},
			],
		});
	};
	return (
		<Section collapsible sectionKey={`${element.id}:animation`}>
			<SectionHeader>
				<SectionTitle>Animation</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<PresetSide side="in" element={element} onApply={onApply} />
					<PresetSide side="out" element={element} onApply={onApply} />
					<p className="text-muted-foreground text-xs">
						Made of keyframes: adjust them on the timeline.
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
