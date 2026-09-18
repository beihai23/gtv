# AGENTS.md — gtv (Git Timeline Viewer)

## Project overview

**gtv** is a read-only desktop app that renders a local git repository's history as a
horizontal timeline of **branch lanes**: every branch gets its own track, is born at a
fork point, and folds back into its parent at a merge. It reconstructs branch lineage
from pure git data — no server, no metadata store, no account. Inspired by gmaster's
Branch Explorer, but an independent codebase.

gtv is **read-only by design, with exactly two sanctioned writes**: a branch
switch the user explicitly confirms (`checkout_branch` — SAFE mode: compatible
uncommitted changes are carried over, never forced; a merge/cherry-pick/revert
in progress is refused; a branch already checked out by a sibling worktree of
the same family is refused up front) and a background auto-fetch of the active
tab's remotes (`fetch_remotes` — updates tracking refs (+auto-followed tags)
& objects & FETCH_HEAD only, never the worktree/local branches/HEAD/stash).
Those two exceptions are the entire write surface. Do not add any other path
that mutates the repository.

## Tech stack

- **Desktop shell**: Tauri 2 (`src-tauri/`), app identifier `com.gtv.app`.
- **Backend**: Rust (edition 2021). Key crates: `git2` (0.20) for all git access,
  `tokio` (only used for `task::spawn_blocking` around git work), `portable-pty`
  (integrated terminal) + `base64` (PTY output chunks), `serde`/`serde_json`,
  `chrono`, `thiserror`, `anyhow`, `log` + `env_logger`. The libgit2 bundled via
  `git2`/`libgit2-sys` must stay >= 1.9.4: older versions refuse to open repos whose
  config carries `extensions.relativeWorktrees` (written by git >= 2.48
  `worktree add --relative-paths`). Guarded by `tests/relative_worktrees_ext.rs`.
- **Frontend**: React 19 + TypeScript (strict) + Vite 7, D3 v7 for the timeline
  rendering (used directly, not via React wrappers — D3 owns the SVG DOM inside
  `Timeline.tsx`), `@xterm/xterm` 5.x for the integrated terminal. Tauri plugins:
  `dialog`, `opener`.

## Repository layout

```
src-tauri/src/
  lib.rs          Tauri builder: plugins, AppState, setup hook (watcher thread),
                  invoke_handler (command registry)
  main.rs         thin entry point calling gtv_lib::run()
  models.rs       all shared data types (CommitNode, BranchLane, GitData, ...) —
                  the single source of truth for the IPC contract
  layout.rs       pure lane-propagation engine; NO git2 dependency, operates only
                  on models so it is unit-testable with hand-built graphs
  git_reader.rs   all git2 access: refs, chunked revwalk from branch tips
                  (walk_commits + load_more pagination), lazy diff stats,
                  worktree status + SAFE branch checkout (the first
                  sanctioned write; refuses branches held by sibling
                  worktrees) and two-commit compare; the second sanctioned
                  write, auto-fetch, runs the SYSTEM git subprocess
                  `git -C <path> fetch --all --quiet` (2026-09-18 user
                  decision: credential fidelity + zero native-dep risk;
                  libgit2 stays default-features = off) and returns a
                  one-line failure summary; change_fingerprint powers the
                  repo-change poller; feeds layout::compute_layout and
                  returns GitData
  commands.rs     #[tauri::command] handlers + AppState (repos registry:
                  repo_id -> RepoSession with view + pagination
                  ViewSession + terminal, plus active/auto_fetch);
                  rebuild_view is the shared refresh path and never writes
                  include_stale
  terminal.rs     integrated-terminal engine: portable-pty spawn/write/resize,
                  reader + flusher threads (8ms output coalescing), login-shell
                  resolution; spawn_pty takes plain callbacks so tests run
                  without a Tauri app
  watcher.rs      repo-change poller thread: fingerprints EVERY open
                  repository every 1.5s (multi-repo) and emits
                  "repo-changed" per repo so the frontend reloads; the CAS
                  write-back lives in the pure apply_fingerprints seam
  fetcher.rs      auto-fetch thread: 60s tick fetching the ACTIVE tab's
                  remotes (busy-skip, auto_fetch gate, silent failure log)
src-tauri/tests/
  layout_pure.rs  10 pure-graph algorithm tests (no git repo involved)
  tour_repo.rs    ground-truth benchmark against docs/reference/gmaster-tour
                  (pre-existing failures in fresh clones: the fixture is a
                  contentless gitlink)
  relative_worktrees_ext.rs  regression: repos created by git >= 2.48
                  `worktree add --relative-paths` must open (libgit2 >= 1.9.4)
  multi_repo.rs   the multi-repo registry: repo_id routing isolation,
                  canonical-path dedup (symlink, races), worktree families,
                  close/active semantics, auto-fetch ticks over file://
                  remotes (write-surface whitelist acceptance), the
                  include_stale single-writer pin, and the watcher CAS race
  terminal_multi.rs  per-repo terminals: spawn routing/idempotency, output
                  isolation, close-linked kill, unknown ids
  pagination.rs   builds a temp repo via the git CLI and pages through it in
                  small chunks: paged result must equal the full walk, the
                  loaded set must stay downward-closed, and excluded stale
                  seeds must never be loaded
  checkout.rs     the M3.1 write path (temp repos via the git CLI): SAFE branch
                  checkout — clean switch, dirty carry-over, conflict refusal
                  with zero side effects, merge/revert-in-progress refusal,
                  cross-worktree occupancy guard — plus worktree-status
                  bucket counts (staged/untracked/MM)
  compare.rs      two-commit compare (file list with per-file +/−, line-level
                  patches, empty diff, unknown oids) + head_branch branch/
                  detached states + regression pins for the parent-vs-commit
                  diff channel
  search.rs       full-history commit search backend: substring match on
                  subject/author (id-prefix for hex), newest-first, in_view
                  membership in the caller's loaded window
  terminal_pty.rs spawn_pty smoke tests: output streaming, cwd, id monotonicity,
                  drop-kill teardown
  repo_fingerprint.rs  change_fingerprint behavior: stable across reads, moves
                  on commit/branch/tag/checkout, ignores worktree noise
src-tauri/examples/
  dump_json.rs    dev tool: dump a repo's GitData as JSON
  dump_links.rs   dev tool: dump a repo's patch links (cherry-pick/rebase) as JSON
  dump_paged.rs   dev tool: page through a repo's ENTIRE history via load_more
                  and dump the final GitData (pagination stress test)
src/
  api.ts          thin wrappers around tauri invoke(), one per backend command
  types.ts        TypeScript mirror of models.rs — keep in sync by hand
  settings.tsx    Settings context: zh/en i18n dictionaries + preset theme
                  palettes (CSS custom properties applied to :root; App.css
                  consumes them via var(--x)), persisted in localStorage
                  (gtv_lang / gtv_theme / gtv_show_stale / gtv_hide_remotes /
                  gtv_inactive_days / gtv_autofetch)
  tabs.ts         pure tab-shell state: commondir grouping, next-active
                  after close, gtv_tabs persist/restore (legacy
                  gtv_latest_repo migration, read-once)
  terminalSize.ts bottom-terminal height clamp + persistence (gtv_term_height)
  compare.ts      compare-pairing pure functions: nextPair (Ctrl+click
                  base/target state machine) + headToLaneTip (pair for the
                  lane-menu "compare with HEAD" item)
  App.tsx         tab shell: open funnel (picker/Cmd+T/drag-drop/restore all
                  through openTab with backend dedup), two-level tab bar,
                  family snapshots + repo-changed refresh, restore, error strip
  RepoView.tsx    per-repo view body (one instance per tab, kept alive via
                  display:none): data state, display pipeline, handlers,
                  header/toolbar, panels, per-tab terminal
  components/Timeline.tsx       the D3 timeline (lanes, edges, badges, minimap,
                                ruler, gestures) — ~1000 lines, the rendering core
  components/CommitDetails.tsx  commit detail panel
  components/CompareDetails.tsx two-commit compare panel (Ctrl+click pairing):
                                side summaries, per-file +/− counts, line diffs
  components/CheckoutDialog.tsx dirty-worktree confirm dialog for the branch
                                switch (three-state copy by status counts)
  components/DiffView.tsx       per-file expandable line diff, shared by
                                CommitDetails and CompareDetails
  components/SettingsDialog.tsx settings modal (Cmd/Ctrl+,): language, theme,
                                stale-branches toggle, About
  components/TerminalPanel.tsx  bottom-docked xterm.js panel: keeps its PTY
                                session alive while hidden (VSCode-style),
                                drag-resize handle, restart/exited states
mock.html         browser-only preview harness + living contract document for
                  the multi-repo frontend surface: mocks window.__TAURI_INTERNALS__
                  (registry semantics, events, terminals, per-repo views) and
                  feeds public/mock-data.json, so the frontend can be debugged
                  and E2E-driven in a plain browser without the Rust backend
docs/
  roadmap.md / design-v2.md / gmaster-research.md   design docs (written in Chinese)
  reference/gmaster-tour    archived real git repo used as the test fixture
  reference/gmaster-io      archived gmaster website material (research only)
  tools/render_gitdata.py   script for rendering dumped GitData
```

## Build, run, and test commands

```bash
npm install                 # frontend deps (also pulls @tauri-apps/cli)
npm run tauri dev           # run the full desktop app (vite dev server + Rust)
npm run build               # typecheck (tsc) + vite production build → dist/
npm run tauri build         # produce a bundled desktop app
npm test                    # frontend pure-function tests (vitest, src/*.test.ts)

cd src-tauri
cargo test                  # ALL tests: pure layout tests + tour-repo benchmark
cargo test --test layout_pure   # just the fast pure-graph tests
cargo run --example dump_json -- /path/to/repo > public/mock-data.json
                            # regenerate the mock.html fixture from a real repo
```

There is no CI, no linter config, and no formatter config beyond the defaults.
TypeScript is the gate on the frontend (`npm run build` runs `tsc` with `strict`,
`noUnusedLocals`, `noUnusedParameters`). Frontend pure-function tests use vitest
(`npm test`, 105 cases across 10 files: `src/inactive.test.ts`,
`src/locate.test.ts`, `src/related.test.ts`, `src/daterange.test.ts`,
`src/refs.test.ts`, `src/persist.test.ts`, `src/terminalSize.test.ts`,
`src/compare.test.ts`, `src/tabs.test.ts`,
`src/components/minimap.test.ts`); all other automated testing lives in Rust.

## Testing strategy

- **`layout.rs` is tested as a pure module.** `tests/layout_pure.rs` builds
  `CommitNode` graphs by hand and asserts lane ownership, fork/merge points, and
  edge types. When changing the lane algorithm, add a hand-built case here.
- **Ground-truth benchmark.** `tests/tour_repo.rs` opens the real archived repo at
  `docs/reference/gmaster-tour` (committed to this repo — do not delete or mutate
  it) and asserts exact lane ownership against what gmaster's own demo renders.
  If a layout change alters lane assignment, this test is the arbiter of whether
  the change is correct.
- **Pagination, not a hard cap.** Each view walks the newest 2000 commits;
  `load_older_commits` pages in older history 2000 at a time (skipping
  already-loaded oids — NOT `revwalk.hide`, whose uninteresting flag
  propagates to ancestors and would suppress the very history being paged).
  The whole loaded set is re-laid out per chunk because lane ownership and
  x coordinates are global; `GitData.has_more` tells the frontend whether
  more history exists, and the Timeline keeps the viewport anchored on a
  commit across the relayout. `AppState.session` (ViewSession) tracks the
  seeds/stale set/loaded oids.
- **Stale branches** (tip outside the loaded window) are controlled by the
  `showStaleBranches` setting (`localStorage` `gtv_show_stale`, default on),
  passed to `open_repository` as `include_stale`. Off = stale seeds are
  removed from the pagination session and hidden from the branch list.
- The revwalk chunk size (2000) is shared by all views; tests use small
  limits to exercise the same paths.

## Code conventions and gotchas

- **IPC contract duplication**: every struct in `models.rs` is mirrored by hand in
  `src/types.ts`. Serde keeps Rust snake_case field names (e.g. `lane_owner`,
  `is_key`, `total_additions`), so the TS interfaces use snake_case too — do not
  camelCase them. When you change one side, change the other and add/remove the
  command in BOTH `lib.rs`'s `invoke_handler!` list and `src/api.ts`.
- New optional fields on serialized structs use `#[serde(default)]` so old dumps
  (e.g. `public/mock-data.json`) keep deserializing.
- `AppState` in `commands.rs` holds the open repo behind `Mutex`; git work is
  blocking, so heavy commands (`open_repository`, `switch_branch`,
  `filter_by_branches`) run inside `task::spawn_blocking`. Follow that pattern.
- Backend errors cross IPC as `Result<T, String>` — error messages are user-facing.
- Tauri events (`"terminal-output"`, `"terminal-exit"`, `"repo-changed"`) follow
  the same mirroring rule: payload structs live in `models.rs` and `src/types.ts`,
  and the event-name strings are declared in the doc comments there. PTY output
  crosses IPC as base64 — chunk boundaries split UTF-8 sequences, so it must be
  decoded to bytes on the frontend, never treated as a lossy string.
- Lane colors come from one place: `layout::lane_color` (lane 0 = main blue,
  others rotate through `LANE_PALETTE`). Don't invent colors elsewhere.
- The frontend persists the open tab list in `localStorage` (key `gtv_tabs`,
  `{ members: [{path, commondir}], active }`); a legacy `gtv_latest_repo`
  single value migrates into a one-member restore, read-once.
- Language: code comments, README, and this file are English; the design docs in
  `docs/` (roadmap.md, design-v2.md, gmaster-research.md) are written in Chinese.
  Match the language of the file you are editing.

## Security considerations

- The app is **read-only by design, with exactly two sanctioned writes**:
  `checkout_branch` — a branch switch the user explicitly confirms after a
  dirty-worktree preflight dialog. It is SAFE-mode only (compatible uncommitted
  changes are carried over; a conflict aborts cleanly before anything is
  written; `force` appears nowhere in the codebase), it refuses while a
  merge/cherry-pick/revert is in progress, and it refuses a branch already
  checked out by a sibling worktree (git's own occupancy rule, mirrored). The
  second write is the fetcher's auto-fetch of the active tab's remotes:
  `git -C <path> fetch --all --quiet` as a subprocess with the inherited
  environment — the ONE place gtv shells out to `git` (2026-09-18 user
  decision: the user's credential helpers/ssh-agent/proxy apply verbatim,
  and libgit2's transports would add openssl-sys/libssh2 native deps). Its
  write surface is tracking refs (+auto-followed tags) & objects &
  FETCH_HEAD only; `--prune` is deliberately absent, and failures are one
  silent log line. Outside those two paths, `GitReader` only opens repos
  and walks history/diffs; there is intentionally no other write path. Do
  not add commands that mutate the user's repository — that red line is
  unchanged and absolute. All other git access stays inside git2.
- The integrated terminal (`terminal.rs` + `TerminalPanel.tsx`) is the other
  deliberate exception: a **user-driven login shell** in a PTY. The user typing
  write commands there is the feature itself — gtv never feeds commands into it
  programmatically, it only relays keystrokes and output, and it watches for
  repo changes by re-reading refs (`change_fingerprint`), never by writing.
- Tauri capabilities (`src-tauri/capabilities/default.json`) are minimal:
  `core:default`, `opener:default`, `dialog:default` only. The terminal and
  repo-watcher events need no extra grants — `core:default` already covers
  event listen/emit.
- `tauri.conf.json` sets `"csp": null` — acceptable for a local-only app that
  renders no remote content; do not load remote URLs/scripts into the webview.
- The app opens arbitrary local paths chosen by the user via the dialog; parse
  nothing from untrusted input and keep treating repo data as display-only.
