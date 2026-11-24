import { expect, test } from "bun:test";
import { retrievalOptions } from "./retrieval-cli";

function usage(message: string): never {
	throw new Error(message);
}

test("retrievalOptions accepts --timeout and --timeout= with the same validation", () => {
	const space = retrievalOptions(["search", "boom", "--timeout", "5", "extra"], usage);
	const equals = retrievalOptions(["search", "boom", "--timeout=5", "extra"], usage);
	expect(space).toEqual({ args: ["search", "boom", "extra"], timeout: 5000 });
	expect(equals).toEqual(space);
	expect(retrievalOptions(["search", "boom", "extra"], usage)).toEqual({
		args: ["search", "boom", "extra"],
		timeout: undefined,
	});
	for (const bad of ["--timeout=", "--timeout=abc", "--timeout=0"]) {
		expect(() => retrievalOptions(["search", bad], usage)).toThrow(
			"--timeout needs a positive number of seconds",
		);
	}
	expect(() => retrievalOptions(["search", "--timeout"], usage)).toThrow(
		"--timeout needs a positive number of seconds",
	);
	expect(() => retrievalOptions(["search", "--timeout", "0"], usage)).toThrow(
		"--timeout needs a positive number of seconds",
	);
});