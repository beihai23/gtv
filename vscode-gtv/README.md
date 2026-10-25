# gtv — Git Timeline Viewer

**Every branch gets its own lane.** gtv draws your repository's history as a
branch-lane timeline inside VS Code: a branch is born where it forks, lives on
its own colored track, and folds back into its parent at the merge — with time
flowing left to right.

![The gtv branch-lane timeline: every branch on its own colored lane, time left to right](https://raw.githubusercontent.com/beihai23/gtv/main/vscode-gtv/docs/screenshots/01-timeline.png)

## Why

`git log` is a pile of commits. `git log --graph` unravels the moment a repo
gets busy. Neither tells you at a glance:

- **Which branch was this commit made on?** — in gtv, position *is* the answer:
  every commit sits on its branch's own lane.
- **Where did this branch come from, where did it go?** — forks and merges are
  drawn explicitly; a merge shows its two parents joining, not a cryptic
  message.
- **What has been merged, what is still in flight?** — active lanes, archived
  lanes and dormant lanes group separately, so work-in-progress is visually
  distinct from finished history.
- **When did things happen?** — a real time axis. History reads like a Gantt
  chart of your development.

## Use it for

- **Reviewing a feature branch before merge** — see exactly what the branch
  did, in isolation on its lane, from fork point to tip.
- **Onboarding onto an unfamiliar repo** — understand years of branching
  strategy in one view instead of hundreds of log lines.
- **Release & hotfix archaeology** — trace when a hotfix shipped, which
  release lanes picked it up, and what else rode along.
- **Untangling merges** — compare any two commits, inspect what a merge really
  brought in, and verify a rebase before pushing.

## How to use

Open a folder that contains a git repository — the timeline opens
automatically (or run **gtv: Open Git Timeline** from the Command Palette, or
click the gtv button in the Source Control title bar). Additional repositories
open as tabs inside the same panel, and linked worktrees are listed per repo.

**Look around** — drag to pan, scroll to zoom, or jump with the minimap.
The **Fit** button frames everything; **HEAD** jumps to your checked-out
commit.

**Inspect a commit** — click any node: full message, author, date, branches
it sits on, and the changed-file list with per-file +/- counts.

![Click a commit for details and its changed files](https://raw.githubusercontent.com/beihai23/gtv/main/vscode-gtv/docs/screenshots/02-commit-details.png)

**Read the actual change** — click a file for the full-width diff, with flat
or tree file lists and unified or side-by-side patch modes.

![The full-width diff view with a syntax-highlighted patch](https://raw.githubusercontent.com/beihai23/gtv/main/vscode-gtv/docs/screenshots/03-diff.png)

**Focus on the branches you care about** — star a branch (★ in the lane menu
or the lane manager) and it becomes a persistent favorite. The header trio
narrows the canvas instantly: **Active** keeps the liveliest lanes, **★
Starred** keeps just your favorites, **All** restores everything. Fold any
lane with the × on its chip — it sinks into a sediment row instead of leaving
a hole. Press `/` for the lane manager: search, star, fold, or include /
exclude branches from the loaded set.

![The ★ Starred view: only your favorites stay on canvas](https://raw.githubusercontent.com/beihai23/gtv/main/vscode-gtv/docs/screenshots/04-starred.png)

**Compare any two commits** — `Ctrl/Cmd+click` two nodes to see everything
that changed between them, with per-file diffs.

![Ctrl/Cmd+click two commits to compare them](https://raw.githubusercontent.com/beihai23/gtv/main/vscode-gtv/docs/screenshots/05-compare.png)

**More** — search commit messages with `Cmd/Ctrl+F`; switch branches from the
branch panel (with a dirty-worktree guard so uncommitted work is never
silently carried or lost); fetch manually or automatically; open an embedded
terminal in the repo's directory.

## Good to know

- Talks to your **system git** directly — your credentials, your remotes, no
  bundled binaries, nothing re-implemented.
- Built for busy repos: the graph renders on Canvas 2D with batched git
  calls, so a 100-lane project still pans, zooms and switches views smoothly.
- The layout engine is a pure function with an extensive test suite: the same
  picture, every time.
- Also available as a standalone desktop app; the VS Code extension shares its
  frontend and engine. See the [repository](https://github.com/beihai23/gtv)
  for the desktop app and development docs.

---

MIT License · [Source & issues](https://github.com/beihai23/gtv)
