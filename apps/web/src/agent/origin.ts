/**
 * True when a browser request comes from another origin than the editor's own (same host and port).
 * Clients without an `Origin` header, such as CLIs, are not browsers and are allowed.
 */
export function isForeignOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return false;
	const host = req.headers.get("host");
	const own = host ? `${new URL(req.url).protocol}//${host}` : new URL(req.url).origin;
	return origin !== own;
}
