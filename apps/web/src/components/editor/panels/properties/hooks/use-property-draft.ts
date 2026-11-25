import { useRef, useState } from "react";
import { evaluateMathExpression } from "@/utils/math";

export function usePropertyDraft<T>({
	displayValue: sourceDisplay,
	parse,
	onPreview,
	onCommit,
	onInvalid,
	onStartEditing,
	supportsExpressions = true,
}: {
	displayValue: string;
	parse: (input: string) => T | null;
	onPreview?: (value: T) => void;
	onCommit: (value: T) => void;
	onInvalid?: () => void;
	onStartEditing?: () => void;
	supportsExpressions?: boolean;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const changed = useRef(false);
	const previewed = useRef(false);
	const scrubValue = useRef<T | null>(null);

	return {
		displayValue: isEditing ? draft : sourceDisplay,
		scrubTo: (value: number) => {
			const parsed = parse(String(value));
			if (parsed === null) return;
			scrubValue.current = parsed;
			onPreview?.(parsed);
		},
		commitScrub: () => {
			const value = scrubValue.current;
			scrubValue.current = null;
			if (value !== null) onCommit(value);
		},
		cancelScrub: () => { scrubValue.current = null; },
		onFocus: () => {
			changed.current = false;
			previewed.current = false;
			setIsEditing(true);
			setDraft(sourceDisplay);
			onStartEditing?.();
		},
		onChange: (
			event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
		) => {
			const nextDraft = event.target.value;
			changed.current = true;
			setDraft(nextDraft);

			const parsed = parse(nextDraft);
			if (parsed !== null && onPreview) {
				previewed.current = true;
				onPreview(parsed);
			}
		},
		onBlur: (
			event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
		) => {
			if (changed.current) {
				const input = event.currentTarget.value;
				let parsed = parse(input);
				if (parsed === null && supportsExpressions) {
					const evaluated = evaluateMathExpression({ input: input.replaceAll(",", ".") });
					if (evaluated !== null) parsed = parse(String(evaluated));
					if (parsed !== null) onPreview?.(parsed);
				}
				if (parsed !== null) onCommit(parsed);
				else if (previewed.current) onInvalid?.();
			}
			changed.current = false;
			previewed.current = false;
			setIsEditing(false);
			setDraft("");
		},
	};
}
