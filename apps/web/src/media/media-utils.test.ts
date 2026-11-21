import { expect, test } from "bun:test";
import { extractMediaFilesFromClipboard, getMediaTypeFromFile } from "./media-utils";

test.each([
	["clip.MKV", "", "video"],
	["clip.ts", "application/octet-stream", "video"],
	["clip.m2ts", "", "video"],
	["clip.m4v", "application/octet-stream", "video"],
	["clip.mov", "", "video"],
	["song.flac", "", "audio"],
	["photo.webp", "application/octet-stream", "image"],
	["clip.gif", "video/mp4", "video"],
	["clip.mkv", "text/plain", null],
	["clip.avi", "application/octet-stream", null],
	["unsupported.exe", "", null],
] as const)("classifies %s with MIME %s", (name, type, mediaType) => {
	expect(getMediaTypeFromFile({ file: new File([], name, { type }) })).toBe(mediaType);
});

test("clipboard reaches import with extension-only media but skips unrelated files", () => {
	const video = new File([], "clip.mkv");
	const audio = new File([], "song.flac", { type: "application/octet-stream" });
	const text = new File([], "note.txt", { type: "text/plain" });
	const items = [video, audio, text].map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }));
	expect(extractMediaFilesFromClipboard({ clipboardData: { items } as unknown as DataTransfer })).toEqual([video, audio]);
});
