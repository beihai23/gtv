// gtv VS Code extension host: owns the webview panel and the Engine,
// and pumps messages between them. All git work lives in the Engine
// (src/engine); this file is transport + VS Code integration only.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Engine } from './engine/engine';

/** snake_case command name -> Engine method name. */
const COMMANDS: Record<string, keyof Engine> = {
  open_repository: 'openRepository',
  close_repository: 'closeRepository',
  set_active_repository: 'setActiveRepository',
  set_auto_fetch: 'setAutoFetch',
  set_include_stale: 'setIncludeStale',
  refresh_repository: 'refreshRepository',
  fetch_repository: 'fetchRepository',
  load_older_commits: 'loadOlderCommits',
  jump_to_commit: 'jumpToCommit',
  switch_branch: 'switchBranch',
  filter_by_branches: 'filterByBranches',
  get_branch_list: 'getBranchList',
  get_commit_detail: 'getCommitDetail',
  get_file_diff: 'getFileDiff',
  get_compare_detail: 'getCompareDetail',
  get_pair_file_diff: 'getPairFileDiff',
  get_commit_stats: 'getCommitStats',
  search_commits: 'searchCommits',
  get_worktree_status: 'getWorktreeStatus',
  checkout_branch: 'checkoutBranch',
  list_worktree_members: 'listWorktreeMembers',
  is_valid_git_repo: 'isValidGitRepo',
};

/** Map a frontend invoke arg object onto the Engine method's positional
 *  parameters. Order mirrors api.ts's wrappers. */
function engineArgs(cmd: string, args: Record<string, unknown>): unknown[] {
  const a = args as Record<string, never>;
  switch (cmd) {
    case 'open_repository': return [a.path, a.includeStale];
    case 'close_repository':
    case 'set_active_repository':
    case 'refresh_repository':
    case 'fetch_repository':
    case 'load_older_commits':
    case 'get_branch_list':
    case 'get_worktree_status':
    case 'list_worktree_members': return [a.repoId];
    case 'set_auto_fetch': return [a.enabled];
    case 'set_include_stale': return [a.repoId, a.enabled];
    case 'jump_to_commit': return [a.repoId, a.commitId];
    case 'switch_branch': return [a.repoId, a.branchName];
    case 'filter_by_branches': return [a.repoId, a.branchNames];
    case 'get_commit_detail': return [a.repoId, a.commitId];
    case 'get_file_diff': return [a.repoId, a.commitId, a.path];
    case 'get_compare_detail': return [a.repoId, a.base, a.target];
    case 'get_pair_file_diff': return [a.repoId, a.base, a.target, a.path];
    case 'get_commit_stats': return [a.repoId, a.commitIds];
    case 'search_commits': return [a.repoId, a.query, a.limit];
    case 'checkout_branch': return [a.repoId, a.branch];
    case 'is_valid_git_repo': return [a.path];
    default: return [];
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gtv.openTimeline', () => openPanel(context)),
  );
}

function openPanel(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'gtv.timeline',
    'Git Timeline',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');

  const engine = new Engine();
  engine.emit = (event, payload) => {
    void panel.webview.postMessage({ type: 'event', event, payload });
  };

  // repo-changed poller + auto-fetch tick — the desktop's watcher.rs and
  // fetcher.rs, transplanted to the host's event loop.
  const watcher = setInterval(() => void engine.pollFingerprints(), 1500);
  const fetcher = setInterval(() => {
    const id = engine.autoFetchTarget();
    if (id) void engine.fetchRepository(id).catch(() => {});
  }, 60000);

  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || m.type !== 'invoke') return;
    const { id, cmd, args } = m as { id: number; cmd: string; args: Record<string, unknown> };
    const reply = (value: unknown) => void panel.webview.postMessage({ type: 'response', id, value });
    const fail = (error: unknown) =>
      void panel.webview.postMessage({
        type: 'response', id,
        error: error instanceof Error ? error.message : String(error),
      });
    try {
      if (cmd === 'plugin:dialog|open') {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: workspaceDir ? vscode.Uri.file(workspaceDir) : undefined,
          title: 'Open Repository',
        });
        reply(picked?.[0]?.fsPath ?? null);
        return;
      }
      if (cmd === 'plugin:opener|open-url') {
        const url = String((args as { url?: string })?.url ?? '');
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        reply(null);
        return;
      }
      // v1: no embedded PTY in the webview — the toggle hides on null.
      if (cmd.startsWith('terminal_')) { reply(null); return; }
      // get_patch_links (cherry-pick detection) is not ported yet: empty.
      if (cmd === 'get_patch_links') { reply([]); return; }
      if (cmd === 'get_recent_logs') { reply([]); return; }

      const method = COMMANDS[cmd];
      if (!method) throw new Error(`Unknown command: ${cmd}`);
      const fn = engine[method] as (...a: unknown[]) => unknown;
      reply(await fn.apply(engine, engineArgs(cmd, args ?? {})));
    } catch (e) {
      fail(e);
    }
  });

  panel.onDidDispose(() => {
    clearInterval(watcher);
    clearInterval(fetcher);
  });

  panel.webview.html = buildHtml(context, panel.webview);
}

/** dist/index.html, rewritten for the webview: asset URLs become
 *  asWebviewUri, the bridge script goes in FIRST (the app expects
 *  __TAURI_INTERNALS__ to exist before its module bundle evaluates), and a
 *  CSP allows exactly the local media dir plus the app's inline styles. */
function buildHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
  const indexPath = path.join(mediaDir.fsPath, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  const bridgeUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'bridge.js'));
  const bridgeTag = `<script src="${bridgeUri}"></script>`;

  // Rewrite every relative asset reference (assets/…) to a webview URI.
  html = html.replace(/(src|href)="(\.\/)?assets\//g, (_m, attr) =>
    `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'assets')).toString()}/`);

  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`;
  html = html.replace(/<head>/, `<head>\n${csp}\n${bridgeTag}`);
  return html;
}

export function deactivate() {}
