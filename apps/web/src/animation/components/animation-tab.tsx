// In and out animation presets for a clip: drawn on top of the clip's own animation, so its keyframes
// stay as they are, and trims, speed changes and copies keep them.
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
	MAX_PRESET_SECONDS,
	MIN_PRESET_SECONDS,
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
	current,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	current: { type: string; duration: number } | null;
	onApply: (request: AnimationPresetRequest) => void;
}) {
	const types = (side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES).filter(
		(type) =>
			(type !== "typewriter" || element.type === "text") &&
			((type !== "blur" && type !== "dissolve") || element.type !== "compound"),
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
							if (Number.isFinite(seconds) && seconds >= MIN_PRESET_SECONDS && seconds <= MAX_PRESET_SECONDS && seconds !== current.duration) apply(type, seconds);
							else setDuration(String(current.duration));
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
	const presets = readAnimationPresets(element);
	const onApply = (request: AnimationPresetRequest) => {
		let next: TimelineElement;
		try {
			next = applyAnimationPresets(element, request);
		} catch (error) {
			toast.error("Animation not applied", { description: error instanceof Error ? error.message : String(error) });
			return;
		}
		// One edit, so one undo.
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch: { params: next.params } }],
		});
	};
	return (
		<Section collapsible sectionKey={`${element.id}:animation`}>
			<SectionHeader>
				<SectionTitle>Animation</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<PresetSide side="in" element={element} current={presets.in} onApply={onApply} />
					<PresetSide side="out" element={element} current={presets.out} onApply={onApply} />
					<p className="text-muted-foreground text-xs">
						Drawn on top of the clip's own keyframes; on a short clip both are shortened to fit.
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
