// Shapes of GET /api/agent/inbox (see inbox.ts), shared with the home page.

/** The bundle a new project would be made from, or why it cannot be read. */
export type InboxBundle = { rev: string; modifiedAt: string } & (
	| { name: string; assets: number; items: number; width: number | null; height: number | null }
	| { error: string }
);
/** The draft waiting for an editor tab of its project, or why it cannot be read. */
export type InboxDraft = { modifiedAt: string } & (
	| { rev: string; projectId: string | null; label: string | null; ops: number }
	| { error: string }
);
export type Inbox = { bundle: InboxBundle | null; draft: InboxDraft | null };

/** Header naming the version of bundle.json a GET returned, so its import can be recorded for that version only. */
export const BUNDLE_REV_HEADER = "x-bopencut-bundle-rev";
