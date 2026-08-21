# AGENTS.md — gtv (Git Timeline Viewer)

## Project overview

**gtv** is a read-only desktop app that renders a local git repository's history as a
horizontal timeline of **branch lanes**: every branch gets its own track, is born at a
fork point, and folds back into its parent at a merge. It reconstructs branch lineage
from pure git data — no server, no metadata store, no account. Inspired by gmaster's
Branch Explorer, but an independent codebase.

gtv **never modifies the repository** it opens. Keep it that way.

## Tech stack

- **Desktop shell**: Tauri 2 (`src-tauri/`), app identifier `com.gtv.app`.
- **Backend**: Rust (edition 2021). Key crates: `git2` (0.20) for all git access,
  `tokio` (only used for `task::spawn_blocking` around git work), `serde`/`serde_json`,
  `chrono`, `thiserror`, `anyhow`, `log` + `env_logger`. The libgit2 bundled via
  `git2`/`libgit2-sys` must stay >= 1.9.4: older versions refuse to open repos whose
  config carries `extensions.relativeWorktrees` (written by git >= 2.48
  `worktree add --relative-paths`). Guarded by `tests/relative_worktrees_ext.rs`.
- **Frontend**: React 19 + TypeScript (strict) + Vite 7, D3 v7 for the timeline
  rendering (used directly, not via React wrappers — D3 owns the SVG DOM inside
  `Timeline.tsx`). Tauri plugins: `dialog`, `opener`.

## Repository layout

```
src-tauri/src/
  lib.rs          Tauri builder: plugins, AppState, invoke_handler (command registry)
  main.rs         thin entry point calling gtv_lib::run()
  models.rs       all shared data types (CommitNode, BranchLane, GitData, ...) —
                  the single source of truth for the IPC contract
  layout.rs       pure lane-propagation engine; NO git2 dependency, operates only
                  on models so it is unit-testable with hand-built graphs
  git_reader.rs   all git2 access: refs, chunked revwalk from branch tips
                  (walk_commits + load_more pagination), lazy diff stats;
                  feeds layout::compute_layout and returns GitData
  commands.rs     #[tauri::command] handlers + AppState (Mutex-guarded current
                  repo/path/branch/view + pagination ViewSession)
src-tauri/tests/
  layout_pure.rs  9 pure-graph algorithm tests (no git repo involved)
  tour_repo.rs    ground-truth benchmark against docs/reference/gmaster-tour
  relative_worktrees_ext.rs  regression: repos created by git >= 2.48
                  `worktree add --relative-paths` must open (libgit2 >= 1.9.4)
  pagination.rs   builds a temp repo via the git CLI and pages through it in
                  small chunks: paged result must equal the full walk, the
                  loaded set must stay downward-closed, and excluded stale
                  seeds must never be loaded
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
                  (gtv_lang / gtv_theme / gtv_show_stale)
  App.tsx         top-level state: repo opening, branch panel, view options
  components/Timeline.tsx       the D3 timeline (lanes, edges, badges, minimap,
                                ruler, gestures) — ~1000 lines, the rendering core
  components/CommitDetails.tsx  commit detail panel
  components/SettingsDialog.tsx settings modal (Cmd/Ctrl+,): language, theme,
                                stale-branches toggle, About
mock.html         browser-only preview harness: mocks window.__TAURI_INTERNALS__
                  and feeds public/mock-data.json, so the frontend can be debugged
                  in a plain browser without the Rust backend
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

cd src-tauri
cargo test                  # ALL tests: pure layout tests + tour-repo benchmark
cargo test --test layout_pure   # just the fast pure-graph tests
cargo run --example dump_json -- /path/to/repo > public/mock-data.json
                            # regenerate the mock.html fixture from a real repo
```

There is no CI, no linter config, and no formatter config beyond the defaults.
TypeScript is the gate on the frontend (`npm run build` runs `tsc` with `strict`,
`noUnusedLocals`, `noUnusedParameters`). The frontend has no test setup — all
automated testing lives in Rust.

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
- Lane colors come from one place: `layout::lane_color` (lane 0 = main blue,
  others rotate through `LANE_PALETTE`). Don't invent colors elsewhere.
- The frontend persists the last opened repo path in `localStorage`
  (key `gtv_latest_repo`).
- Language: code comments, README, and this file are English; the design docs in
  `docs/` (roadmap.md, design-v2.md, gmaster-research.md) are written in Chinese.
  Match the language of the file you are editing.

## Security considerations

- The app is **read-only by design**: `GitReader` only opens repos and walks
  history/diffs; there is intentionally no write path. Do not add commands that
  mutate the user's repository.
- Tauri capabilities (`src-tauri/capabilities/default.json`) are minimal:
  `core:default`, `opener:default`, `dialog:default` only.
- `tauri.conf.json` sets `"csp": null` — acceptable for a local-only app that
  renders no remote content; do not load remote URLs/scripts into the webview.
- The app opens arbitrary local paths chosen by the user via the dialog; keep all
  git access inside git2 (no shelling out to `git`).
