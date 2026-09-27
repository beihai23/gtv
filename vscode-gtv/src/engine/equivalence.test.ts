// Equivalence test: the TS engine (git CLI + ported layout) and the Rust
// backend (dump_json example) must produce the same GitData for the same
// repository. This is the anti-drift gate for the no-Rust architecture.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine } from './engine';

// __dirname = vscode-gtv/src/engine → three up is the repo root.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DUMP = path.join(ROOT, 'src-tauri', 'target', 'debug', 'examples', 'dump_json');

function git(dir: string, args: string[], date: string) {
  execFileSync('git', ['-c', 'user.name=gtv', '-c', 'user.email=gtv@gtv.local', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: 'pipe',
  });
}

/** A small repo with: a merged feature branch, an open feature branch,
 *  a tag, and a stale branch whose tip sits outside the first page. */
function buildRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gtv-eq-${name}-`));
  git(dir, ['init', '-q', '-b', 'main'], '2026-01-01T09:00:00');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
  git(dir, ['add', '.'], '2026-01-01T09:00:00');
  git(dir, ['commit', '-q', '-m', 'initial'], '2026-01-01T09:00:00');
  git(dir, ['checkout', '-q', '-b', 'feat/login'], '2026-01-02T09:00:00');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v2\n');
  git(dir, ['commit', '-q', '-am', 'feat: login'], '2026-01-02T09:00:00');
  git(dir, ['checkout', '-q', 'main'], '2026-01-03T09:00:00');
  git(dir, ['merge', '-q', '--no-ff', 'feat/login', '-m', 'merge login'], '2026-01-04T09:00:00');
  git(dir, ['tag', 'v1.0'], '2026-01-04T09:00:00');
  git(dir, ['checkout', '-q', '-b', 'feat/open'], '2026-01-05T09:00:00');
  fs.writeFileSync(path.join(dir, 'g.txt'), 'x\n');
  git(dir, ['add', '.'], '2026-01-05T09:00:00');
  git(dir, ['commit', '-q', '-m', 'feat: open work'], '2026-01-05T09:00:00');
  git(dir, ['checkout', '-q', 'main'], '2026-01-06T09:00:00');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v3\n');
  git(dir, ['commit', '-q', '-am', 'chore: bump'], '2026-01-06T09:00:00');
  return dir;
}

/** Deep-compare two GitData dumps with float tolerance. */
function assertSameView(ts: any, rs: any, label: string) {
  const clean = (v: any): any => JSON.parse(JSON.stringify(v));
  ts = clean(ts); rs = clean(rs);
  expect(ts.main_branch, `${label} main_branch`).toBe(rs.main_branch);
  expect(ts.has_more, `${label} has_more`).toBe(rs.has_more);
  expect(ts.head_branch, `${label} head_branch`).toBe(rs.head_branch ?? null);
  expect(ts.head_commit_count, `${label} head_commit_count`).toBe(rs.head_commit_count ?? null);

  expect(ts.commits.length, `${label} commit count`).toBe(rs.commits.length);
  for (let i = 0; i < ts.commits.length; i++) {
    const a = ts.commits[i], b = rs.commits[i];
    expect(a.id, `${label} commit[${i}] id`).toBe(b.id);
    for (const k of ['lane', 'lane_owner', 'is_key', 'is_head', 'fork_branch_name', 'merge_branch_name'] as const) {
      expect(a[k] ?? null, `${label} commit[${i}].${k}`).toBe(b[k] ?? null);
    }
    expect(a.parents).toEqual(b.parents);
    expect(Math.abs(a.x - b.x), `${label} commit[${i}].x`).toBeLessThan(1e-6);
    expect(a.y, `${label} commit[${i}].y`).toBe(b.y);
    // Ref badges: same set, order-insensitive.
    const ar = [...a.branch_refs.map((r: any) => `${r.name}:${r.is_tag}:${r.is_remote}`)].sort();
    const br = [...b.branch_refs.map((r: any) => `${r.name}:${r.is_tag}:${r.is_remote}`)].sort();
    expect(ar, `${label} commit[${i}].branch_refs`).toEqual(br);
  }

  const edgeKey = (e: any) => `${e.from}->${e.to}:${e.edge_type}`;
  expect(ts.edges.map(edgeKey).sort(), `${label} edges`).toEqual(rs.edges.map(edgeKey).sort());

  expect(ts.branches.length, `${label} lane count`).toBe(rs.branches.length);
  for (let i = 0; i < ts.branches.length; i++) {
    const a = ts.branches[i], b = rs.branches[i];
    expect(a.name, `${label} lane[${i}] name`).toBe(b.name);
    expect(a.lane_index, `${label} lane[${i}] index`).toBe(b.lane_index);
    expect(a.color, `${label} lane[${i}] color`).toBe(b.color);
    expect(a.fork_point ?? null, `${label} lane[${i}] fork`).toBe(b.fork_point ?? null);
    expect(a.merged_into ?? null, `${label} lane[${i}] merged`).toBe(b.merged_into ?? null);
  }

  expect(ts.time_gaps, `${label} time_gaps`).toEqual(rs.time_gaps);
}

describe('TS engine ⇔ Rust backend equivalence', () => {
  it('same view for a merged+open+tagged repo', async () => {
    if (!fs.existsSync(DUMP)) {
      // execSync-with-shell is fragile inside vitest workers; build via
      // execFileSync (no shell) instead.
      execFileSync('cargo', ['build', '--example', 'dump_json'], {
        cwd: path.join(ROOT, 'src-tauri'), stdio: 'inherit',
      });
    }
    const dir = buildRepo('basic');
    const engine = new Engine();
    const opened = await engine.openRepository(dir, true);
    const rust = JSON.parse(execFileSync(DUMP, [dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    assertSameView(opened.data, rust, 'basic');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120000);

  it('branch list carries lane colors from the built view, tags are chips', async () => {
    const dir = buildRepo('chips');
    const engine = new Engine();
    const opened = await engine.openRepository(dir, true);
    const list = await engine.getBranchList(opened.repo_id);
    const names = list.map(b => b.name);
    expect(names).toContain('main');
    expect(names).toContain('feat/login');
    expect(names).toContain('feat/open');
    expect(names).toContain('v1.0');
    expect(list.find(b => b.name === 'v1.0')?.is_tag).toBe(true);
    expect(list.find(b => b.name === 'main')?.color).toBe('#4A90D9');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('commit detail carries real per-file +/- (the desktop defers this)', async () => {
    const dir = buildRepo('detail');
    const engine = new Engine();
    const opened = await engine.openRepository(dir, true);
    const merge = opened.data.commits.find((c: any) => c.message === 'merge login');
    const detail = await engine.getCommitDetail(opened.repo_id, merge!.id);
    expect(detail).not.toBeNull();
    expect(detail!.files.length).toBeGreaterThan(0);
    expect(detail!.total_additions).toBeGreaterThan(0);
    expect(detail!.files[0].additions + detail!.files[0].deletions).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('fingerprint moves on commit, stays put on worktree noise', async () => {
    const dir = buildRepo('fp');
    const engine = new Engine();
    await engine.openRepository(dir, true);
    let emitted = 0;
    engine.emit = () => { emitted++; };
    await engine.pollFingerprints(); // first poll only re-baselines
    expect(emitted).toBe(0);
    fs.writeFileSync(path.join(dir, 'noise.txt'), 'x\n'); // untracked: no event
    await engine.pollFingerprints();
    expect(emitted).toBe(0);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'tick'], '2026-01-07T09:00:00');
    await engine.pollFingerprints();
    expect(emitted).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
