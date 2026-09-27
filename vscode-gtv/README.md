# gtv — Git Timeline Viewer (VS Code extension)

The gtv branch-lane timeline inside VS Code: every branch gets its own track,
is born at a fork point, and folds back into its parent at a merge — without
leaving your editor.

**No Rust, no native modules, no bundled binaries.** The extension talks to
your system `git` directly (same credential-fidelity decision as the desktop
app's fetch), and the lane-layout engine is a TypeScript port of the desktop's
pure `layout.rs` with its full test-vector suite.

## Use

1. Open a folder containing a git repository.
2. Run the command **gtv: Open Git Timeline** (Command Palette, or the gtv
   button in the Source Control title bar).
3. The timeline opens in an editor tab. Additional repositories can be opened
   as tabs inside the panel (the welcome screen's Open Repository button, which
   defaults to the workspace folder).

Everything you know from the desktop app works: pan/zoom, ref panel (`/`),
search (`Cmd/Ctrl+F`), two-commit compare (`Ctrl/Cmd+click`), the full-width
diff split view with flat/tree file lists and unified/side-by-side patch
modes, branch switching with the dirty-worktree guard, and manual + automatic
fetch.

Not in v1: the embedded xterm terminal (VS Code already has a better one —
use it), patch-copy (cherry-pick) link detection, drag-and-drop folder opening
(webviews can't read dropped folder paths — use the picker), and the
create-issue context packer.

## Develop

```bash
cd vscode-gtv
npm install
npm run sync-web   # rebuild the frontend (../npm run build) into media/
npm run build      # bundle the extension host to dist/extension.js
npm test           # vitest: layout port, Rust-equivalence, full-stack E2E
```

Then press **F5** in VS Code with this folder open to launch an Extension
Development Host.

## How it fits together

```
src/extension.ts    host: webview panel, message pump, watcher + fetch ticks
src/engine/
  gitcli.ts         spawn git, stderr tails
  reader.ts         all repository reading via the git CLI (mirrors
                    src-tauri/src/git_reader.rs semantics)
  layout.ts         the pure lane engine, ported 1:1 from
                    src-tauri/src/layout.rs (tests ported too)
  engine.ts         session registry + command dispatch (mirrors
                    src-tauri/src/commands.rs AppState)
media/bridge.js     the webview-side __TAURI_INTERNALS__ polyfill over
                    acquireVsCodeApi — the desktop frontend runs unchanged
media/              dist/ of the desktop frontend (npm run sync-web) + bridge
```

The frontend (React + D3, `../src/`) is shared verbatim with the desktop app;
only the transport differs (Tauri IPC ↔ VS Code postMessage).
