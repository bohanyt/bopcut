import { useState, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { toast } from "sonner";
import { fetchWebMedia, hasWebMedia, mediaLinksOf } from "@/media/web-drop";
import type { MediaImportSession } from "@/core/managers/media-manager";

interface UseFileUploadOptions {
	accept?: string;
	multiple?: boolean;
	onFilesSelected?: (files: File[], session: MediaImportSession | null) => void;
}

export function useFileUpload({
	accept,
	multiple,
	onFilesSelected,
}: UseFileUploadOptions = {}) {
	const editor = useEditor();
	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounterRef = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const pickerSession = useRef<MediaImportSession | null>(null);

	function containsFiles(dataTransfer: DataTransfer): boolean {
		return (
			!editor.timeline.dragSource.isActive() &&
			(dataTransfer.types.includes("Files") ||
				hasWebMedia([...dataTransfer.types]))
		);
	}

	function openFilePicker() {
		if (!inputRef.current) return;

		inputRef.current.accept = accept || "*";
		inputRef.current.multiple = multiple || false;
		pickerSession.current = editor.media.startImport();
		inputRef.current.click();
	}

	function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		const session = pickerSession.current ?? editor.media.startImport();
		pickerSession.current = null;
		if (files.length > 0 && onFilesSelected) {
			onFilesSelected(files, session);
		}

		if (event.target) {
			event.target.value = "";
		}
	}

	function handleDragEnter(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current += 1;
		setIsDragOver(true);
	}

	function handleDragOver(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;
	}

	function handleDragLeave(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current -= 1;
		if (dragCounterRef.current === 0) {
			setIsDragOver(false);
		}
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setIsDragOver(false);
		dragCounterRef.current = 0;

		if (onFilesSelected && containsFiles(e.dataTransfer)) {
			const session = editor.media.startImport();
			if (!session) return;
			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) {
				// An image (or video/sound) dragged from another web page: read the links now, fetch after.
				const links = mediaLinksOf(e.dataTransfer);
				if (links.length === 0) return;
				void fetchWebMedia(links, session.signal).then(({ file, error }) => {
					if (session.signal.aborted) return;
					if (file) onFilesSelected([file], session);
					else toast.error(`Could not add the dropped media${error ? `: ${error}` : ""}`);
				});
				return;
			}
			const shouldUseMultiple = multiple ?? false;

			if (shouldUseMultiple) {
				onFilesSelected(files, session);
			} else if (files.length > 0) {
				onFilesSelected([files[0]], session);
			}
		}
	}

	return {
		isDragOver,
		openFilePicker,
		fileInputProps: {
			ref: inputRef,
			type: "file",
			style: { display: "none" },
			onChange: handleFileChange,
		},
		dragProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
