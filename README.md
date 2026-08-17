# gtv — Git Timeline Viewer

<p align="center">
  <img src="docs/assets/logo.png" width="128" alt="gtv logo"/>
</p>

A desktop app that draws your git history the way gmaster's legendary **Branch Explorer**
did: a horizontal blackboard where every branch lives on its own lane, is born at a fork
point, and folds back into its parent at a merge.

<p align="center">
  <img src="docs/assets/gtv-tour-after.png" alt="gtv rendering the official gmaster tour repository"/>
</p>

<p align="center"><em>
gtv rendering the official gmaster "tour" demo repository — the same repo gmaster's own
Branch Explorer video used, recovered from the GitHub fork network.
</em></p>

## Why

`git log --graph` is linear text. It cannot show you *branch parallelism*: which branches
exist, where each was born, where it merged back, and which lines are still alive.
gmaster (Codice Software, discontinued 2018) solved this with the Branch Explorer;
after the Codice → Unity acquisition it lives on only inside Unity Version Control.
gtv re-creates that view from **pure git data** — no server metadata — using
first-parent lane propagation.

## Features

- **Branch lanes from pure DAG structure** — every commit is assigned to its branch's
  lane via first-parent lineage (tip protection walls, merged-branches-first priority)
- **Fork / merge annotations** — right-angle branch-birth lines and thin merge links,
  labeled with the branch names involved
- **Smart compression** (gmaster's key trick) — by default only *key* commits are shown:
  lane births, lane tips, merge sources/targets, tagged commits, HEAD. Click a `+N` chip
  on a lane bar to expand its hidden commits; toggle `Compress` to see everything
- **Lane focus** — click a lane name (or right-click → *Focus this lane*) to dim
  everything else; merge links touching the focused lane stay visible
- **Time-proportional x-axis** with a top time ruler (per-lane minimum spacing keeps
  dense clusters readable)
- **Change-volume node sizing** — bigger nodes = bigger diffs (key commits only)
- **Minimap** with viewport rectangle and click-to-jump
- **Display options** — toggle merge links / ref labels
- **Branch filter chips**, commit search, commit detail panel with `+add/−del` stats,
  remembers your last repository
- Read-only. gtv never modifies your repository.

## Development

```bash
npm install
npm run tauri dev        # run the app
cd src-tauri && cargo test   # layout engine tests + gmaster-tour benchmark
```

Try it on the bundled benchmark repo: **Open Repository** → `docs/reference/gmaster-tour`
(14 commits, 7 branches, merged/unmerged/branch-from-branch — with a known-good answer).

## Architecture

```
src-tauri/src/
  layout.rs       pure lane-propagation engine (no git2 — unit-tested with hand-built graphs)
  git_reader.rs   git2 access: refs, revwalk from all branch tips, diff stats
  commands.rs     Tauri commands
src/
  components/Timeline.tsx      D3 timeline: lanes, bars, compression, focus, minimap
  components/CommitDetails.tsx commit detail panel
docs/
  design-v2.md          full design doc (lane algorithm spec, rendering spec, roadmap)
  gmaster-research.md   Branch Explorer research notes + feature mapping
```

## Roadmap status

- [x] P0 lane correctness (propagation, typed edges, fork/merge labels, HEAD marker)
- [x] P1 information density (smart compression, time-proportional axis, node sizing)
- [x] P2 view controls (display options, minimap, lane focus)
- [~] P3 lane as operation entry (context menu → view-from-branch done; real checkout/diff pending)

## License

MIT
