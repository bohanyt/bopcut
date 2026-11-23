# bopencut goal

**From sources to finished video, with an agent doing most of the work and a human in full control on one shared timeline.**

## Workflow

```
sources → agent asks what to make → 1. agent drafts → 2. human edits → 3. agent refines → export
                                              ↑                                   |
                                              └── 4. agent records preferences ←─┘
```

1. **The agent reads the sources, asks what to make, and drafts the video.** Start with any mix of links, articles, documents, or footage. A script is one possible source. After summarizing the material, the agent asks for the type, aspect ratio, length, and language that the request and saved preferences leave open. Aim for a draft that is about 75% complete, with voice-over, captions, footage, motion graphics, and transitions as editable elements.
2. **The human edits directly.** Move, trim, and resize on the timeline and in the preview. Add PNGs, GIFs, or footage.
3. **The human asks the agent to refine specific parts.** For example, "speed up this transition" or "add a label to this graphic". The agent reads the current timeline and changes only the requested part. The human can undo the result in one step and repeat the review and refinement loop until the video is ready to export.
4. **The agent learns from human edits.** Each human edit to an agent-created item is logged with its previous and new values. The agent writes a preference rule only when the same pattern appears **at least 3 times**, with evidence. The human can edit or delete the rule, and the agent reads it before the next draft.

Preferences have two levels:
- **General**, for all projects: `PREFERENCES.md` in the folder specified by `AGENT_PREFS`.
- **Per project/channel:** `PREFERENCES.md` in `AGENT_WORKSPACE`.

These are private and are not stored in this public repository. The repository contains only the mechanism.

## Feature filter

New features are implemented only if they make one of the steps above **faster or better**. If it is unclear which step benefits, the feature is deferred.

- Project-specific details (a particular scene or channel style) do not belong in this repository. bopencut contains only general capabilities: primitives, presets, and agent workflows.
- Real scenes may be used for testing, but they are test material, not features.

## Stages

A stage is complete when its **Done when** criteria are met and tested directly in the editor.

| # | Stage | Steps supported | Status | Done when |
|---|---|---|---|---|
| ? | **Folder storage** | 1, 2, 3, 4 | Done (#7) | Projects and media are stored in a local folder, open in another browser, and old browser projects are safely copied |
| 0 | Agent bridge: draft import, timeline sync, draft set/add/delete | 1, 3 | Done (#1) | The agent adds, changes, and deletes items in the open project; one Undo reverses everything |
| 1 | **Timeline notes + agent frame viewing** | 3 | Done (#4) | The human marks a time range/item with a note; the agent reads it and can capture any frame |
| 1b | **Edit log + preferences** | 4 → 1 | Done (#2) | Human edits to agent-created items are logged in `edits/<projectId>.jsonl`; the agent writes preference rules from recurring patterns, and the next draft uses them |
| 2 | **Motion graphics building blocks:** icons (Iconify), lines/arrows/paths, groups, draw progress | 1, 3 | Done (#6); partial leftovers: `drawProgress` for stroke icons, group transforms with animated members untested | The agent builds a scene from icons and shapes; each part can be dragged and resized in the preview |
| 3 | **Lively motion + transitions:** easing, bounce, stagger, appear/move/disappear presets, transitions between clips | 1, 3 | Planned | The stage 2 scene moves without looking stiff; the human can change presets per element |
| 4 | **Before/after:** ghost of another state + path in preview | 2 | Planned | Animation start and end positions are visible and can be dragged directly |
| 5 | **Depth:** shadows, gradients, parallax, camera (zoom/pan) | 1 | Planned | The scene has depth without rendering outside the editor |
| 6 | **3D:** 3D model and text elements (Three.js), rendered per frame | 1 | Done (#5); 3D text, material color, and loading placeholder later | 3D models look identical in preview and export; position/rotation can be keyframed |
| 7 | **Script → generic draft:** draft format from script + voice-over independent of a specific project | 1 | Planned | A new script becomes a draft in the editor without project-specific code |
| 8 | **Ready for local agents:** one-command setup and loopback server (#223), a source-first playbook, and agent CLI commands for status, selection, notes, frames, and export. Server-side draft application is tracked in #213. | 1, 3, 4 | In progress | From a fresh clone, run `bun run start:local` and point an agent at `AGENTS.md`. Given sources, it summarizes them, asks what to make, creates an editable draft, checks the hook, and exports an MP4. |
| — | **Preview quality:** Full / ½ / ¼ | 2 | Done (#8) | Preview quality is selectable without reducing export or agent frame quality |
| — | **Compound clips:** many layers as one clip referencing a nested scene; double-click to edit inside | 1, 2, 3 | Done: A foundation (#13: data model, rendering, audio, create/ungroup commands); B timeline UI (#14: create/break apart shortcuts and menu, double-click to enter, breadcrumb, thumbnails, rename, deep-copy duplicate/paste); C agent path (snapshot of nested content with root-time intervals and addresses, draft ops inside compounds, `group`/`ungroup`/`compound` ops, one Undo across scenes, bundle compounds, nested edit log) | Foundation, timeline UI, and agent path are complete |

## Later

- Lottie (ready-made animation)
- Convert old Manim scenes → primitives
- Shape morph A → B, data charts
- Voice recording in the editor
