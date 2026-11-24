import path from "node:path";
import { describe, expect, test } from "bun:test";
import { insidePath } from "./inside";

describe("inside", () => {
	test("win32 drive root and media folder", () => {
		const p = path.win32;
		expect(insidePath("D:\\", "a\\b.mp4", p)).toBe(p.resolve("D:\\", "a\\b.mp4"));
		expect(() => insidePath("D:\\", "C:\\a", p)).toThrow();
		expect(() => insidePath("D:\\media", p.normalize("D:\\..\\x"), p)).toThrow();
		expect(insidePath("D:\\media", "..data\\x", p)).toBe(p.resolve("D:\\media", "..data\\x"));
		expect(() => insidePath("D:\\media", "D:\\media2\\x", p)).toThrow();
	});

	test("posix root and media folder", () => {
		const p = path.posix;
		expect(insidePath("/", "a/b.mp4", p)).toBe(p.resolve("/", "a/b.mp4"));
		expect(() => insidePath("/media", "/a", p)).toThrow();
		expect(() => insidePath("/media", p.normalize("/../x"), p)).toThrow();
		expect(insidePath("/media", "..data/x", p)).toBe(p.resolve("/media", "..data/x"));
		expect(() => insidePath("/media", "/media2/x", p)).toThrow();
	});
});
