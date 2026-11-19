// Server side of the draft file: a draft is applied once. When the editor reports a draft as applied,
// draft.json moves to drafts-applied/, so no other project opened later picks it up again.
import { promises as fs } from "node:fs";
import path from "node:path";

/** Test seams: run between the steps, to simulate an agent writing a new draft at that moment. */
export type ConsumeHooks = { beforeClaim?: () => Promise<void>; afterClaim?: () => Promise<void> };

async function readRev(file: string): Promise<unknown> {
	try {
		return (JSON.parse(await fs.readFile(file, "utf8")) as { rev?: unknown })?.rev;
	} catch {
		return undefined;
	}
}

const unique = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Move `draft.json` to `drafts-applied/<rev>-<time>.json` when its rev is the one just applied.
 * A newer draft written meanwhile (another rev) stays in place. Returns where the draft went, or null.
 *
 * The file is claimed first (renamed away, which is atomic) and its rev checked after: checking first and
 * moving after could move a newer draft the agent wrote in between.
 */
export async function consumeAppliedDraft(workspace: string, rev: unknown, hooks: ConsumeHooks = {}): Promise<string | null> {
	if (typeof rev !== "string" || !rev) return null;
	const file = path.join(workspace, "draft.json");
	// Most of the time draft.json still holds that draft; when it does not, nothing needs to move.
	if ((await readRev(file)) !== rev) return null;
	await hooks.beforeClaim?.();
	const dir = path.join(workspace, "drafts-applied");
	await fs.mkdir(dir, { recursive: true });
	const claim = path.join(dir, `.claim-${unique()}.json`);
	try {
		await fs.rename(file, claim);
	} catch {
		return null;
	}
	await hooks.afterClaim?.();
	if ((await readRev(claim)) === rev) {
		const safe = rev.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "draft";
		const target = path.join(dir, `${safe}-${Date.now()}.json`);
		await fs.rename(claim, target);
		return target;
	}
	await putBack(claim, file, dir);
	return null;
}

/** The claimed file is a newer draft: back to draft.json, unless the agent already wrote an even newer one. */
async function putBack(claim: string, file: string, dir: string): Promise<void> {
	try {
		// A hard link fails when draft.json exists again, so an even newer draft is never overwritten.
		await fs.link(claim, file);
		await fs.unlink(claim);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			// No hard links on this file system: rename back if draft.json is still free.
			const free = await fs.stat(file).then(() => false, () => true);
			if (free) {
				await fs.rename(claim, file);
				return;
			}
		}
	}
	// Superseded by a newer draft, as if the agent had overwritten it: keep it for reference.
	await fs.rename(claim, path.join(dir, `superseded-${unique()}.json`));
}
