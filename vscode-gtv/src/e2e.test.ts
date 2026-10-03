// Full-stack E2E without VS Code: the REAL frontend bundle (media/, the
// desktop app's vite build), the REAL bridge.js, and the REAL Engine,
// glued exactly the way extension.ts does it (postMessage invoke pump +
// engine.emit -> webview event). Playwright drives the page in Chromium.
// Run: npx vitest run src/e2e.test.ts  (needs `node esbuild.mjs --sync-web`
// once so media/ exists; needs playwright installed at the repo root —
// it is, for the mock.html harness work).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { Engine } from './engine/engine';

const MEDIA = path.resolve(__dirname, '..', 'media');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function serve(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const p = path.join(MEDIA, decodeURIComponent(req.url ?? '/').replace(/^\/+/, '') || 'index.html');
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    if (path.extname(file) === '.html') {
      // Same injection extension.ts does for the real webview: bridge first.
      const html = fs.readFileSync(file, 'utf8')
        .replace(/<head>/, '<head>\n<script src="/bridge.js"></script>');
      res.end(html);
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
  }));
}

function buildRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-e2e-'));
  const git = (args: string[], date: string) =>
    execFileSync('git', ['-c', 'user.name=gtv', '-c', 'user.email=gtv@gtv.local', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main'], '2026-01-01T09:00:00');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
  git(['add', '.'], '2026-01-01T09:00:00');
  git(['commit', '-q', '-m', 'initial commit'], '2026-01-01T09:00:00');
  git(['checkout', '-q', '-b', 'feat/x'], '2026-01-02T09:00:00');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v2\n');
  git(['commit', '-q', '-am', 'feat: x'], '2026-01-02T09:00:00');
  git(['checkout', '-q', 'main'], '2026-01-03T09:00:00');
  git(['merge', '-q', '--no-ff', 'feat/x', '-m', 'merge x'], '2026-01-04T09:00:00');
  return dir;
}

describe('vscode extension full stack (no VS Code)', () => {
  let browser: Browser;
  let page: Page;
  let server: { port: number; close: () => void };
  let engine: Engine;
  let repoDir: string;
  // Captured open_external_terminal args.path values (the VS Code host's
  // terminal surface — extension.ts turns it into vscode.window.createTerminal).
  const terminalCalls: string[] = [];

  beforeAll(async () => {
    expect(fs.existsSync(path.join(MEDIA, 'index.html')), 'media/ built (run node esbuild.mjs --sync-web)').toBe(true);
    repoDir = buildRepo();
    engine = new Engine();
    server = await serve();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    page = await ctx.newPage();
    page.on('pageerror', e => console.error('PAGEERR', e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 300)); });

    // The bridge expects acquireVsCodeApi: postMessage → host. The host
    // answers through a MessageEvent back into the page, and engine events
    // get pushed the same way — exactly extension.ts's pump shape.
    await page.exposeFunction('__hostInvoke', async (m: { id: number; cmd: string; args: Record<string, unknown> }) => {

      const reply = (value: unknown) => ({ type: 'response', id: m.id, value });
      const fail = (error: unknown) => ({ type: 'response', id: m.id, error: String(error) });
      try {
        const a = m.args ?? {};
        switch (m.cmd) {
          case 'plugin:dialog|open': return reply(repoDir);
          case 'plugin:opener|open-url': return reply(null);
          case 'get_patch_links': return reply([]);
          case 'get_recent_logs': return reply([]);
          // Host-only surface (no Engine method): record the cwd the
          // webview asked the VS Code terminal to open at.
          case 'open_external_terminal': terminalCalls.push(String(a.path)); return reply(null);
          default: {
            const cmd = m.cmd.replace(/_([a-z])/g, (_s, c: string) => c.toUpperCase()) as keyof Engine;
            const fn = engine[cmd] as unknown as (...x: unknown[]) => Promise<unknown>;
            if (typeof fn !== 'function') return fail(new Error(`Unknown command: ${m.cmd}`));
            // Same positional mapping as extension.ts engineArgs, keyed by
            // the SNAKE_CASE command name.
            const argMap: Record<string, unknown[]> = {
              open_repository: [a.path, a.includeStale],
              get_commit_detail: [a.repoId, a.commitId],
              get_file_diff: [a.repoId, a.commitId, a.path],
              get_compare_detail: [a.repoId, a.base, a.target],
              get_pair_file_diff: [a.repoId, a.base, a.target, a.path],
              get_commit_stats: [a.repoId, a.commitIds],
              search_commits: [a.repoId, a.query, a.limit],
              jump_to_commit: [a.repoId, a.commitId],
              switch_branch: [a.repoId, a.branchName],
              filter_by_branches: [a.repoId, a.branchNames],
              checkout_branch: [a.repoId, a.branch],
              set_include_stale: [a.repoId, a.enabled],
              set_auto_fetch: [a.enabled],
              is_valid_git_repo: [a.path],
            };
            const positional = argMap[m.cmd] ?? [a.repoId];
            return reply(await fn.apply(engine, positional));
          }
        }
      } catch (e) {
        return fail(e instanceof Error ? e.message : e);
      }
    });
    engine.emit = (event, payload) => {
      void page.evaluate(({ event, payload }) => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'event', event, payload } }));
      }, { event, payload });
    };
    // extension.ts owns the 1.5s watcher tick; the harness owns it here.
    setInterval(() => void engine.pollFingerprints(), 1500);

    await page.addInitScript((repoPath) => {
      // @ts-expect-error test stub
      window.acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => {
          // @ts-expect-error exposed by the host
          void window.__hostInvoke(m).then((r: unknown) =>
            window.dispatchEvent(new MessageEvent('message', { data: r })));
        },
        getState: () => undefined,
        setState: () => undefined,
      });
      // Restore the repo as an open tab (the desktop restore path).
      localStorage.setItem('gtv_tabs', JSON.stringify({
        members: [{ path: repoPath, commondir: repoPath + '/.git' }],
        active: repoPath,
      }));
    }, repoDir);
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`${repoDir}-wt`, { recursive: true, force: true });
  });

  it('boots into the timeline for the restored repo', async () => {
    await page.goto(`http://127.0.0.1:${server.port}/index.html`);
    await page.waitForSelector('g.node', { state: 'attached', timeout: 20000 });
    const nodes = await page.locator('g.node').count();
    expect(nodes).toBeGreaterThan(0);
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll('div.lane-chip')].map(c => c.textContent?.trim()));
    expect(chips.join(' ')).toContain('main');
    // feat/x is merged and old: the inactive-lane collapse sinks it into the
    // Archived group row by design (same as the desktop). Its presence is
    // proven through the engine's branch list instead of the canvas rail.
    expect(chips.join(' ')).toContain('Archived (1)');
    const repoId = (await engine.openRepository(repoDir, true)).repo_id;
    const names = (await engine.getBranchList(repoId)).map(b => b.name);
    expect(names).toContain('feat/x');
  }, 60000);

  it('commit details + file diff + watcher event all flow over the bridge', async () => {
    await page.goto(`http://127.0.0.1:${server.port}/index.html`);
    await page.waitForSelector('g.node', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(1000);
    // select a commit → details panel
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('g.node')][1];
      g.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('.commit-details', { timeout: 10000 });
    const hasFiles = await page.locator('.file-row').count();
    expect(hasFiles).toBeGreaterThan(0);
    // open the split view → diff loads through the engine
    await page.locator('.file-row').first().click();
    await page.waitForSelector('.diff-split-right .diff-line', { timeout: 10000 });
    const lines = await page.locator('.diff-split-right .diff-line').count();
    expect(lines).toBeGreaterThan(3);

    // watcher: a new commit outside the app must surface as repo-changed
    const refreshed = page.evaluate(() => new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 8000);
      const orig = window.dispatchEvent.bind(window);
      // listen via the bridge's own event channel: patch a listener
      window.addEventListener('message', (e) => {
        const m = e.data as { type?: string; event?: string };
        if (m?.type === 'event' && m.event === 'repo-changed') {
          clearTimeout(t);
          resolve(true);
        }
      });
      void orig; // silence unused
    }));
    execFileSync('git', ['-c', 'user.name=gtv', '-c', 'user.email=gtv@gtv.local', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--allow-empty', '-m', 'external tick'], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-05T09:00:00', GIT_COMMITTER_DATE: '2026-01-05T09:00:00' },
    });
    expect(await refreshed).toBe(true);
  }, 60000);

  // The terminal button under the VS Code host must open VS Code's
  // integrated terminal at the CURRENT worktree member — after a member
  // switch, not at the family's main dir.
  it('terminal button targets the worktree member dir after a member switch', async () => {
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-lane', `${repoDir}-wt`], { cwd: repoDir, stdio: 'pipe' });
    // git reports the realpath (macOS /var -> /private/var); compare in
    // canonical form.
    const wtDir = fs.realpathSync(`${repoDir}-wt`);
    await page.goto(`http://127.0.0.1:${server.port}/index.html`);
    await page.waitForSelector('g.node', { state: 'attached', timeout: 20000 });
    // The worktree add moved refs; give the family refresh a beat, then
    // switch member through the worktree menu.
    await page.locator('.member-menu-btn').waitFor({ timeout: 10000 });
    await page.locator('.member-menu-btn').click();
    await page.locator('.member-item', { hasText: 'wt-lane' }).click();
    await page.waitForFunction(
      (dir) => document.querySelector('.repo-path')?.getAttribute('title') === dir,
      wtDir,
      { timeout: 20000 },
    );
    const before = terminalCalls.length;
    await page.locator('.terminal-toggle-btn').click();
    expect(terminalCalls.length).toBe(before + 1);
    expect(terminalCalls[terminalCalls.length - 1]).toBe(wtDir);
  }, 60000);
});
