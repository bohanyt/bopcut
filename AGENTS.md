# Agents.md

## Mode 1 — Editing videos (default)

**bopencut is a place to edit video alongside a human.** You will usually be asked to **create or refine a video**, not change bopencut code. Change code only when the owner explicitly asks (see the rules below).

1. **Intake.** Start with whatever the human supplies: a long video or live link, articles, documents, a footage folder, or a script. Read the text and any available transcripts first. Inspect frames and fetch only the sections you need. For a live stream, use available text and wait for the replay if a cut needs footage. Sum up what you understood in a few lines. Consult both preference files before asking what to make: vertical clips, a scripted video, or something custom, with the aspect ratio, length, and language. Ask only for details the request and preferences leave open.
2. **Read the project context.** Read both [preference files](AGENT.md#preferences) if present (general in `AGENT_PREFS`, project in `AGENT_WORKSPACE`). Run `bun run agent status` and `bun run agent notes` for the target project. Use the latest ready snapshot before changing an existing timeline.
3. **Plan the beats.** Put the hook first, then map the story, supporting footage, sound, captions, and the ending to the requested duration.
4. **Gather material.** Reuse existing media and use the [retrieval commands](AGENT.md#media-from-links-sections-not-whole-videos) for sections, sound effects, music, and images. Leave source files in place. Give long jobs such as fetching, transcription, and export a time limit and report progress by stage. If a job times out, report which stage stopped.
5. **Draft on the editable timeline.** Import a bundle for a new project or write `draft.json` with `basedOn` for changes. Keep the editor tab open to apply the draft and check that it saved. Use the [file protocol](AGENT.md#agent-workspace-appswebenvlocal) for the formats and apply results.
6. **Check the opening and key beats.** Capture frames with `bun run agent frames --project-id PROJECT_ID --times 0,1,2`, using the target project ID and times within the video. Inspect the 0 s frame and review the first spoken words and when they start. The first 1–2 seconds should carry a strong line, an on-screen claim, or a visible reaction. Cut any dead air before the first word. If the opening is uncertain, offer two or three alternatives as separate drafts.
7. **Export MP4.** Run `bun run agent export --project-id PROJECT_ID --format mp4` after the draft saves. The server must be running, and the editor tab can be closed.
8. **Report.** Give the MP4 path, summarize your main choices, list any alternative drafts, and say what the human should check. They can watch the export and fix individual items on the same timeline.
9. **Refine.** Read new notes and human edits, then change the requested parts. Reply to or resolve the notes you addressed. Record preference rules only when the same pattern appears at least three times, with evidence.

See [AGENT.md](AGENT.md) for protocol details. Footage and assets live under `AGENT_FILES_ROOT`.

## Mode 2 — Changing bopencut's code (only when explicitly asked)

- **This repository is public.** Do not include AI attribution anywhere (no AI co-author lines or AI model or vendor names), or the owner's project, client, channel, laptop path, or private data in code, comments, documents, or commit messages. Project-specific details stay outside the repository; bopencut contains only general capabilities (see the feature filter in `GOAL.md`).
- One stage = one branch + one PR to `main`. Do not push directly to `main`.
- CI must pass: in `apps/web`, run `bun run build`, `bunx tsc --noEmit -p .`, and `bun test`. Do not suppress type errors (`@ts-ignore`, `any` to avoid errors, `ignoreBuildErrors`) or delete tests to pass.
- Test in a browser only through browser tab automation. Do not use desktop controls (mouse, keyboard, screen screenshots, or system clipboard) on the owner's machine.
- Do not commit project data or agent workspace folders (`workspace/`, `BOPENCUT_DATA`, `AGENT_WORKSPACE`).
- Follow the surrounding code style. Write code, comments, agent docs, commits, and PRs in English.
- Add user-visible UI text to both the English and Indonesian dictionaries in `apps/web/src/i18n/`. Use the [Indonesian UI glossary](docs/glossary-id.md) for consistent editing terms.
- Keep the [Indonesian README](README.md) and [English README](README.en.md) in sync.
- The agent workspace protocol (bundles, drafts, notes, frames, preferences) is in `AGENT.md`; update it when the format changes.

## Repository layout

The Next.js editor, agent bridge, storage server and renderer integration live in `apps/web`. Shared primitives used by the editor's WebAssembly dependency live in `rust/`. The desktop prototype lives in `apps/desktop`.

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

