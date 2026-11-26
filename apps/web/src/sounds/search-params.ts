import { z } from "zod";

export const soundSearchParamsSchema = z.object({
	q: z.string().max(500, "Query too long").optional(),
	type: z.enum(["songs", "effects"]).optional(),
	page: z.coerce.number().int().min(1).max(1000).default(1),
	page_size: z.coerce.number().int().min(1).max(150).default(20),
	sort: z
		.enum(["downloads", "rating", "created", "score"])
		.default("downloads"),
	min_rating: z.coerce.number().min(0).max(5).default(3),
	// "false" must mean false: z.coerce.boolean() turns every non-empty string into true.
	commercial_only: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
});

/** The search options of a sounds request; missing values take their defaults. */
export function parseSoundSearchParams(searchParams: URLSearchParams) {
	return soundSearchParamsSchema.safeParse({
		q: searchParams.get("q") || undefined,
		type: searchParams.get("type") || undefined,
		page: searchParams.get("page") || undefined,
		page_size: searchParams.get("page_size") || undefined,
		sort: searchParams.get("sort") || undefined,
		min_rating: searchParams.get("min_rating") || undefined,
		commercial_only: searchParams.get("commercial_only") || undefined,
	});
}
