// Branch-deletion freshness: the whole watcher -> refresh chain must be
// reflected on the view. Deleting a LOCAL branch removes its lane on the
// next refresh (fingerprint moves -> repo-changed -> rebuild), and deleting
// a REMOTE branch disappears after the next fetch -- which prunes stale
// tracking refs (2026-10-18 decision revising the 2026-09-18 no-prune call;
// without prune origin/x survived every fetch and the lane never left).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepoReader } from './reader';
import { Engine } from './engine';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=gtv', '-c', 'user.email=gtv@gtv.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'pipe' });

describe('local branch deletion refreshes the view', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-del-')));
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    // A real feature lane: its own commit, so the branch owns a lane (a
    // ref pointing at an existing commit renders no lane of its own).
    git(dir, ['checkout', '-q', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'feat work']);
    git(dir, ['checkout', '-q', 'main']);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('poll -> repo-changed -> refresh drops the deleted lane', async () => {
    const engine = new Engine();
    const events: string[] = [];
    engine.emit = (event) => { events.push(event); };
    const opened = await engine.openRepository(dir, true);
    expect(opened.data.branches.map(b => b.name)).toContain('feat');

    git(dir, ['branch', '-D', 'feat']);
    await engine.pollFingerprints();
    expect(events).toContain('repo-changed');

    const view = await engine.refreshRepository(opened.repo_id);
    expect(view.branches.map(b => b.name)).not.toContain('feat');
    // And the engine's later branch list agrees (the manager panel's source).
    const listed = await engine.getBranchList(opened.repo_id);
    expect(listed.map(b => b.name)).not.toContain('feat');
    await engine.closeRepository(opened.repo_id);
  });

  it('a stale fingerprint baseline does not swallow the deletion', async () => {
    // Two ref movements in a row: the first poll consumed the first one;
    // the second deletion must still move the fingerprint (each poll
    // compares against the LAST baseline, not the open-time one).
    const engine = new Engine();
    const opened = await engine.openRepository(dir, true);
    git(dir, ['checkout', '-q', '-b', 'tmp1']);
    fs.writeFileSync(path.join(dir, 'tmp.txt'), 'tmp\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'tmp work']);
    git(dir, ['checkout', '-q', 'main']);
    await engine.pollFingerprints(); // baseline absorbs tmp1's creation
    git(dir, ['branch', '-D', 'tmp1']);
    await engine.pollFingerprints();
    const view = await engine.refreshRepository(opened.repo_id);
    expect(view.branches.map(b => b.name)).not.toContain('tmp1');
    await engine.closeRepository(opened.repo_id);
  });
});

describe('remote branch deletion disappears after fetch (prune)', () => {
  let base: string;
  let upstream: string;
  let clone: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-prune-')));
    const seed = path.join(base, 'seed');
    upstream = path.join(base, 'upstream.git');
    clone = path.join(base, 'clone');
    git(base, ['init', '-q', '-b', 'main', seed]);
    fs.writeFileSync(path.join(seed, 'f.txt'), 'v1\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'init']);
    git(base, ['clone', '-q', '--bare', seed, upstream]);
    git(base, ['clone', '-q', `file://${upstream}`, clone]);
    git(seed, ['branch', 'feat']);
    git(seed, ['push', '-q', `file://${upstream}`, 'feat']);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('fetch brings origin/feat in, then a pruned fetch drops it', async () => {
    const reader = await RepoReader.open(clone);
    await reader.fetch();
    let seeds = await reader.laneSeeds();
    expect(seeds.map(s => s.name)).toContain('origin/feat');

    // Delete upstream-side (the GitHub "delete branch" button's effect):
    const seedDir = path.join(base, 'seed');
    git(seedDir, ['push', '-q', `file://${upstream}`, '--delete', 'feat']);

    await reader.fetch();
    seeds = await reader.laneSeeds();
    expect(seeds.map(s => s.name)).not.toContain('origin/feat');
  });
});
