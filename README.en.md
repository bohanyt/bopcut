[Read in Indonesian](README.md)

# bopencut — one timeline for you and your agent

**bopencut** is a web video editor where **you and an agent edit the same timeline**. The agent reads your sources and drafts the video you ask for. You move, trim, and arrange clips in an interface like CapCut, then ask the agent to refine the parts you point out. You can undo every agent change, and your edits are preserved.

> bopencut is a fork of **OpenCut (classic)** by the [OpenCut](https://github.com/opencut-app/opencut-classic) team under the MIT license (see [`LICENSE`](LICENSE)). The underlying editor is entirely their work. The original OpenCut README is at [`docs/opencut-original-readme.md`](docs/opencut-original-readme.md).

## What you can do

**Work with an agent**
- **Keep your changes during rewrites.** An agent draft can preserve the fields you edited on its clips, including caption corrections, color, and placement. Release them from the clip menu when you want the agent to change them again.
- **The agent can read the timeline.** Each change is written to the workspace as JSON, including tracks, items, times, positions, and notes.
- **The agent can edit the timeline.** It sends per-item additions, updates, and deletions. The editor applies them in about two seconds as **one Undo step** and selects the affected items.
- **Two-way notes.** Leave a note on a range or an item, or draw a box on the preview. The agent can read, reply to, and resolve it.
- **Frame images.** The agent can request an image of a frame at any time.
- **Review a range.** Read a compact transcript of saved words with `transcript-view`, or use `view` to make a PNG with frames, audio peaks, words, and clip edges. The editor can stay closed. [Agent CLI](AGENT.md#agent-cli)
- **Fetch a video segment from a link.** Give a link and start and end times, such as a 20-second segment from a three-hour stream. yt-dlp fetches just that segment with frame-accurate cuts. Use an agent draft, the CLI, or the link button in the Assets panel.
- **Find sound effects by name.** Search your own sound folders and Myinstants without an account. Use the Library tab in the Sounds panel, or put `sfx: "vine boom"` in an agent draft. Downloaded sounds become part of your library.
- **Find music by title.** Search your own music folders or fetch just the audio online through yt-dlp. Loudness is normalized on download. The agent can also duck music under speech with adjustable volume keyframes.
- **Camera shake.** Add anything from a subtle handheld shake to a damped jolt over your existing position and zoom, with keyframeable intensity.
- **Styled captions.** Use one element per phrase with per-word timing, double outlines, a glow or shadow, highlights for important words and the current word, and word-by-word fade or pop. Save your styles as presets.
- **Drag images from web pages.** Drop images from Google Images or another page into Assets or the timeline, as in Photopea, or paste an image link.
- **Teach the agent your preferences.** Your changes to agent-created items are logged and summarized into suggested editing preferences.

**Editor**
- **Record voice-over.** Use the timeline microphone or Shift+R, then record at the playhead and choose between takes.
- Projects and media are saved **in folders on disk**, so any browser on the same laptop can open them.
- Motion graphics include icons from Iconify, lines, arrows and paths with a draw effect, and object groups.
- GLB/glTF 3D models render frame by frame.
- Set the preview to Full, ½, or ¼ resolution. Exports always use full resolution.
- Dropped GIFs automatically become animated video.

## Running

Install [Bun](https://bun.sh). Put `ffmpeg` on your PATH for GIF-to-video conversion. Install [yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch clips from links. See `AGENT.md` for its configuration. No account, database, or Docker is required.

```
bun install
cd apps/web && bunx next dev --turbopack -H 127.0.0.1 -p 3000
```

Open `http://127.0.0.1:3000/projects`.

Use the **EN / ID** button in the header to choose English or Bahasa Indonesia. The app remembers your choice in that browser.

## Where data is stored

| Data | Default location | Override in `apps/web/.env.local` |
| --- | --- | --- |
| Projects and media | `<repo>/workspace/projects/` | `BOPENCUT_DATA` |
| Agent workspace (sync files, drafts, frames, edit logs) | `<repo>/workspace/` | `AGENT_WORKSPACE` |
| Asset root the agent may read | Same as `AGENT_WORKSPACE` | `AGENT_FILES_ROOT` |

`BOPENCUT_DATA` points to the parent of `projects/`. Git ignores `workspace/`. If you use another folder, keep it out of Git as well. When the Projects page loads, it copies old browser projects and their media to disk before you open a project. The browser copies stay intact.

## Using bopencut with a local agent

Run bopencut, open your coding agent in the repository, and ask it to **"read `AGENTS.md`, then help me make a video from these sources."** Share links, articles, documents, or a footage folder. A script is optional. The agent summarizes what it understood, asks what to make, and uses the shared timeline to draft, check, and export your video.

## Documentation

- [GOAL.md](GOAL.md) covers the goals, workflow, and stages.
- [AGENT.md](AGENT.md) describes the workspace protocol for bundles, drafts, notes, frames, and preferences.
- [AGENTS.md](AGENTS.md) is the entry point for agents and includes rules for code changes.

## License

MIT, as with OpenCut. See [`LICENSE`](LICENSE).
