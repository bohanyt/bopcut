# Agents.md

## Mode 1 — Editing videos (default)

**bopcut is a place to edit video alongside a human.** You will usually be asked to **create or refine a video**, not change bopcut code. Change code only when the owner explicitly asks (see the rules below).

What you can build with:

- **Shared timeline:** voice-over, footage, captions, motion graphics and transitions as editable elements. Every change can be undone, and none overwrites the human's edits.
- **Editable motion graphics:** icons, shapes, lines, arrows and paths with a draw effect, groups, and keyframes. Each part can be moved and resized in the preview.
- **3D models** (GLB/glTF) that rotate and animate with keyframes.
- **Eyes for you:** frame images at any time, so you check your work before reporting.
- **Notes and preferences:** the human's timeline notes and `PREFERENCES.md` files.

### Playbook

1. **Intake.** Start with whatever the human supplies: a long video or live link, articles, documents, a footage folder, or a script. Read the text and any available transcripts first. Inspect frames and fetch only the sections you need. For a live stream, use available text and wait for the replay if a cut needs footage. Sum up what you understood in a few lines. Consult both preference files before asking what to make: vertical clips, a scripted video, or something custom, with the aspect ratio, length, and language. Ask only for details the request and preferences leave open. If the human names an inspiration (a creator, a channel, or a few videos) to learn from, study it before asking anything else. Use transcripts, frames, and cut timing from a few short sections, never full downloads. Write a style note in `AGENT_WORKSPACE/styles/<name>.md`: how the opening hooks; how they talk (sentence length, words per second, how sentences open, what they cut); how the story is built and how each part hands over to the next; shot length, captions, B-roll density, sound effects, and music. Show a short summary and wait for an OK. Learn the format and the way of talking, and never copy the reference's footage, voice, characters, or assets.
2. **Read the project context.** Read both [preference files](AGENT.md#preferences) if present (general in `AGENT_PREFS`, project in `AGENT_WORKSPACE`). Identify the target project ID, then run `bun run agent status --project-id PROJECT_ID` and `bun run agent notes --project-id PROJECT_ID` for an existing project. Use the latest ready snapshot before changing an existing timeline.
3. **Plan the beats.** Put the hook first, then map the story, supporting footage, sound, captions, and the ending to the requested duration. For a scripted video, write the script from the human's own material in `AGENT_WORKSPACE/scripts/<name>.md`, in the agreed style, and show it for an OK before drafting. Keep it concise: cut setup, filler, and repetition before adding anything.
4. **Gather material.** Reuse existing media and use the [retrieval commands](AGENT.md#media-from-links-sections-not-whole-videos) for sections, sound effects, music, and images. Leave source files in place. For narration, use `bun run agent voice` when `BOPENCUT_TTS` is set, one line or section per file, and add the returned `asset` with its words; otherwise ask the human for a recording. Give long jobs such as fetching, transcription, voice, and export a time limit and report progress by stage. If a job times out, report which stage stopped.
5. **Draft on the editable timeline.** Import a bundle for a new project or write `draft.json` with `basedOn` for changes and set its `projectId` to the target project ID. Keep the editor tab open to apply the draft and check that it saved. Use the [file protocol](AGENT.md#agent-workspace-appswebenvlocal) for the formats and apply results.
6. **Check the opening and key beats.** Capture frames with `bun run agent frames --project-id PROJECT_ID --times 0,1,2`, using the target project ID and times within the video. Inspect the 0 s frame and review the first spoken words and when they start. The first 1–2 seconds should carry a strong line, an on-screen claim, or a visible reaction. Cut any dead air before the first word. `bun run agent silence-plan --project-id PROJECT_ID` proposes cuts for dead air and filler sounds from the stored words. If the opening is uncertain, offer two or three alternatives as separate drafts.
7. **Export MP4.** Run `bun run agent export --project-id PROJECT_ID --format mp4` after the draft saves. The server must be running, and the editor tab can be closed.
8. **Review the finished export.** Run `bun run agent review --project-id PROJECT_ID --file PATH`. Read `review.json` and the evidence for errors and warnings. Fix confirmed issues by draft, export again, and repeat for at most three review passes. Keep informational findings as context. Report anything that remains, including skipped checks.
9. **Report.** Give the MP4 path, summarize your main choices, list any alternative drafts, and say what the human should check. They can watch the export and fix individual items on the same timeline.
10. **Refine.** Read new notes and human edits, then change the requested parts. Reply to or resolve the notes you addressed. Record preference rules only when the same pattern appears at least three times, with evidence.

See [AGENT.md](AGENT.md) for protocol details. Footage and assets live under `AGENT_FILES_ROOT`; never modify source files there.

## Mode 2 — Changing bopcut's code (only when explicitly asked)

- **This repository is public.** Do not include AI attribution anywhere (no AI co-author lines or AI model or vendor names), or the owner's project, client, channel, laptop path, or private data in code, comments, documents, or commit messages. Project-specific details stay outside the repository; bopcut contains only general capabilities (see the feature filter in `GOAL.md`).
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

