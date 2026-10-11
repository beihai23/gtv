// worktreeFamily staleness: a member whose directory was deleted outside
// git (or via `git worktree remove`) must drop out of the family list —
// mirrors the desktop's validate() skip in git_reader.rs.
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

describe('worktreeFamily staleness', () => {
  let dir: string;
  const wt = (name: string) => `${dir}-${name}`;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-wtfam-')));
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    git(dir, ['worktree', 'add', '-q', '-b', 'feat/a', wt('a')]);
    git(dir, ['worktree', 'add', '-q', '-b', 'feat/b', wt('b')]);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt('a'), { recursive: true, force: true });
    fs.rmSync(wt('b'), { recursive: true, force: true });
  });

  it('lists every live member', async () => {
    const reader = await RepoReader.open(dir);
    const names = (await reader.worktreeFamily()).map(m => m.name);
    expect(names).toEqual([path.basename(dir), `${path.basename(dir)}-a`, `${path.basename(dir)}-b`]);
  });

  it('drops a member whose directory was deleted (not yet pruned)', async () => {
    fs.rmSync(wt('a'), { recursive: true, force: true });
    const reader = await RepoReader.open(dir);
    const names = (await reader.worktreeFamily()).map(m => m.name);
    expect(names).toEqual([path.basename(dir), `${path.basename(dir)}-b`]);
  });

  it('drops a member removed via git worktree remove', async () => {
    git(dir, ['worktree', 'remove', '--force', wt('b')]);
    const reader = await RepoReader.open(dir);
    const names = (await reader.worktreeFamily()).map(m => m.name);
    expect(names).toEqual([path.basename(dir)]);
  });
});

// repo-missing watcher: a session whose directory was deleted outside the
// app must surface as a repo-missing event (the desktop watcher's
// apply_fingerprints seam does the same via ApplyOutcome.missing) instead
// of retrying the fingerprint silently forever.
describe('pollFingerprints repo-missing', () => {
  const initRepo = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    return dir;
  };

  it('emits repo-missing when the session directory was deleted', async () => {
    const dir = initRepo('gtv-missing-');
    const engine = new Engine();
    const events: { event: string; payload: unknown }[] = [];
    engine.emit = (event, payload) => events.push({ event, payload });
    const opened = await engine.openRepository(dir, true);

    fs.rmSync(dir, { recursive: true, force: true });
    await engine.pollFingerprints();

    expect(events).toEqual([
      { event: 'repo-missing', payload: { repo_id: opened.repo_id, path: dir } },
    ]);
  });

  it('stays quiet when the fingerprint fails but the directory exists', async () => {
    const dir = initRepo('gtv-transient-');
    const engine = new Engine();
    const events: { event: string; payload: unknown }[] = [];
    engine.emit = (event, payload) => events.push({ event, payload });
    await engine.openRepository(dir, true);

    // The directory is still there but no longer a repo: the fingerprint
    // throws while existsSync(path) holds — the transient case the next
    // tick retries.
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    await engine.pollFingerprints();

    expect(events).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
