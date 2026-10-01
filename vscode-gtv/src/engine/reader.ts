// Repository reading via the system git CLI, mirroring the desktop app's
// git_reader.rs semantics one command at a time. Every method documents its
// Rust counterpart. The layout itself (computeLayout) is the ported pure
// engine in ./layout.ts — this file produces CommitNode[] and friends.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, gitRaw, summarizeStderr } from './gitcli';
import { computeLayout, laneColor, TAG_COLOR, type LaneSeed } from './layout';
import type {
  BranchLane,
  BranchRef,
  CommitDetail,
  CommitNode,
  CommitStat,
  CompareDetail,
  CompareSide,
  FileChange,
  GitData,
  SearchHit,
  WorktreeMember,
  WorktreeStatus,
} from '../../../src/types';

export interface ViewResult {
  data: GitData;
  seeds: LaneSeed[];
  staleNames: string[];
}

const PAGE = 2000;
const US = '\x1f'; // field separator in --format strings
const RS = '\x1e'; // record separator
// --format: id, short, author name, author email, committer timestamp,
// parents, subject (summary — the desktop shows the first line in-graph).
const LOG_FORMAT = `%H${US}%h${US}%an${US}%ae${US}%ct${US}%P${US}%s${RS}`;

export class RepoReader {
  private constructor(public readonly dir: string) {}

  /** Open and validate: `git rev-parse --git-dir` must succeed. Mirrors
   *  GitReader::new (libgit2 repo open). */
  static async open(dir: string): Promise<RepoReader> {
    const r = await gitRaw(dir, ['rev-parse', '--git-dir']);
    if (r.code !== 0) {
      throw new Error(`Not a git repository: ${dir}${summarizeStderr(r.stderr)}`);
    }
    return new RepoReader(dir);
  }

  static async isValid(dir: string): Promise<boolean> {
    const r = await gitRaw(dir, ['rev-parse', '--git-dir']);
    return r.code === 0;
  }

  /** Canonical (symlink-resolved) working dir — the dedupe key. Mirrors
   *  canonical_path(). */
  async canonicalPath(): Promise<string> {
    return fs.realpathSync(this.dir);
  }

  /** Shared git dir of the worktree family. Mirrors commondir(). */
  async commondir(): Promise<string> {
    const out = await git(this.dir, ['rev-parse', '--git-common-dir']);
    return fs.realpathSync(path.resolve(this.dir, out.trim()));
  }

  /** oid -> refs pointing at it. Mirrors get_all_references: tags, remotes
   *  and locals all badge; symbolic refs (origin/HEAD) carry no badge. */
  private async refMap(): Promise<Map<string, BranchRef[]>> {
    const out = await git(this.dir, [
      'for-each-ref',
      `--format=%(refname)%00%(objectname)%00%(symref)`,
      'refs/heads', 'refs/remotes', 'refs/tags',
    ]);
    const map = new Map<string, BranchRef[]>();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, oid, symref] = line.split('\0');
      if (!name || !oid || symref) continue; // symref: no badge (Rust target() = None)
      const isTag = name.startsWith('refs/tags/');
      const isRemote = name.startsWith('refs/remotes/');
      const short = name
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/tags\//, '')
        .replace(/^refs\/remotes\//, '');
      const list = map.get(oid) ?? [];
      list.push({ name: short, is_remote: isRemote, is_tag: isTag, color: '' });
      map.set(oid, list);
    }
    return map;
  }

  /** Lane seeds: all local branches, plus remote branches whose short name
   *  has no local counterpart. Local lanes take the short name; remote-only
   *  lanes keep the full `origin/x` name and carry is_remote = true.
   *  Mirrors collect_lane_seeds. */
  async laneSeeds(): Promise<LaneSeed[]> {
    const out = await git(this.dir, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs/heads', 'refs/remotes',
    ]);
    const seeds: LaneSeed[] = [];
    const localNames = new Set<string>();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, oid] = line.split('\0');
      if (!name || !oid) continue;
      if (name.startsWith('refs/heads/')) {
        const short = name.slice('refs/heads/'.length);
        localNames.add(short);
        seeds.push({ name: short, tip: oid, is_remote: false });
      }
    }
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, oid] = line.split('\0');
      if (!name || !oid || !name.startsWith('refs/remotes/')) continue;
      const full = name.slice('refs/remotes/'.length);
      const short = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full;
      if (short === 'HEAD' || localNames.has(short)) continue;
      // A local branch literally named "origin/x" already owns that lane name.
      if (seeds.some(s => s.name === full)) continue;
      seeds.push({ name: full, tip: oid, is_remote: true });
    }
    return seeds;
  }

  /** main > master > first remote `origin/main`-style seed > first
   *  `origin/master`-style seed > first seed. Mirrors detect_main_branch. */
  private detectMainBranch(seeds: LaneSeed[]): string {
    const names = new Set(seeds.map(s => s.name));
    if (names.has('main')) return 'main';
    if (names.has('master')) return 'master';
    const shortOf = (s: LaneSeed) => {
      const i = s.name.indexOf('/');
      return i < 0 ? undefined : s.name.slice(i + 1);
    };
    return (seeds.find(s => s.is_remote && shortOf(s) === 'main')
      ?? seeds.find(s => s.is_remote && shortOf(s) === 'master')
      ?? seeds[0])?.name ?? '';
  }

  private async headOid(): Promise<string | null> {
    const r = await gitRaw(this.dir, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Branch shorthand of HEAD, null while detached/unborn. Mirrors
   *  head_branch(). */
  async headBranch(): Promise<string | null> {
    const r = await gitRaw(this.dir, ['symbolic-ref', '--short', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** rev-list --count HEAD, null while unborn. Mirrors head_commit_count. */
  private async headCommitCount(): Promise<number | null> {
    const r = await gitRaw(this.dir, ['rev-list', '--count', 'HEAD']);
    if (r.code !== 0) return null;
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** HEAD + sorted refs — any ref movement changes it; worktree edits do
   *  not. Mirrors change_fingerprint (the string differs from the desktop's
   *  but the semantics are identical: it only has to MOVE on change). */
  async fingerprint(): Promise<string> {
    const head = await gitRaw(this.dir, ['symbolic-ref', '-q', 'HEAD']);
    const headOid = await gitRaw(this.dir, ['rev-parse', 'HEAD']);
    const headPart =
      head.code === 0 ? `${head.stdout.trim()}=${headOid.stdout.trim()}`
      : headOid.code === 0 ? `HEAD=${headOid.stdout.trim()}`
      : 'unborn';
    const refs = await gitRaw(this.dir, ['show-ref']);
    const refList = refs.code === 0
      ? refs.stdout.split('\n').filter(Boolean).map(l => {
          const [oid, name] = l.split(' ');
          return `${name}=${oid}`;
        }).sort().join(';')
      : '';
    return `${headPart}|${refList}`;
  }

  /** Newest-first windowed walk from seed tips. Mirrors walk_commits:
   *  TIME|TOPOLOGICAL ≈ git log --date-order, dedupe by oid, `hide` skips
   *  already-loaded oids client-side (never git's hide semantics — the
   *  desktop learned that lesson with revwalk.hide propagating to
   *  ancestors). */
  async walk(seeds: LaneSeed[], hide: ReadonlySet<string>, limit: number): Promise<CommitNode[]> {
    const refs = await this.refMap();
    // Pre-validate tips: one bad tip must not fail the whole walk (Rust
    // skips unparseable oids; an empty push set falls back to HEAD).
    const tips: string[] = [];
    for (const s of seeds) {
      const r = await gitRaw(this.dir, ['rev-parse', '--verify', '--quiet', `${s.tip}^{commit}`]);
      if (r.code === 0) tips.push(s.tip);
    }
    const revArgs = tips.length > 0 ? tips : ['HEAD'];
    // No -n when hiding: the limit applies AFTER filtering, like the Rust
    // revwalk's in-loop skip. (git log walks newest-first either way.)
    // Tips are revisions, not paths: they go after the format flags.
    const finalArgs = ['log', '--date-order', `--format=${LOG_FORMAT}`];
    if (hide.size === 0) finalArgs.push('-n', String(limit));
    finalArgs.push(...revArgs);
    const out = await git(this.dir, finalArgs, 60000);

    const commits: CommitNode[] = [];
    const seen = new Set<string>();
    for (const rec of out.split(RS)) {
      const rec2 = rec.replace(/^\n+/, '');
      if (!rec2) continue;
      const f = rec2.split(US);
      if (f.length < 7) continue;
      const [id, short, an, ae, ct, parents, subject] = f;
      if (!id || seen.has(id) || hide.has(id)) continue;
      seen.add(id);
      commits.push({
        id,
        short_id: short,
        message: (subject ?? '').replace(/\n$/, ''),
        author_name: an || 'Unknown',
        author_email: ae ?? '',
        timestamp: parseInt(ct, 10) || 0,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        branch_refs: refs.get(id) ?? [],
        fork_branch_name: null,
        merge_branch_name: null,
        lane_owner: '',
        is_head: false,
        is_key: false,
        additions: 0,
        deletions: 0,
        x: 0,
        y: 0,
        lane: 0,
      });
      if (commits.length >= limit) break;
    }
    return commits;
  }

  /** Walk + layout. Mirrors build_view. */
  async buildView(seeds: LaneSeed[], limit = PAGE): Promise<GitData> {
    const mainBranch = this.detectMainBranch(seeds);
    const headId = await this.headOid();
    const headBranch = await this.headBranch();
    const headCount = await this.headCommitCount();
    const commits = await this.walk(seeds, new Set(), limit);
    const hasMore = commits.length === limit;
    const { lanes, edges, timeGaps } = computeLayout(commits, seeds, mainBranch, headId);
    return {
      commits,
      edges,
      branches: lanes,
      main_branch: mainBranch,
      time_gaps: timeGaps,
      has_more: hasMore,
      head_branch: headBranch,
      head_commit_count: headCount,
    };
  }

  /** Stale = tip never entered the loaded window. Mirrors stale_seeds. */
  private staleSeeds(seeds: LaneSeed[], data: GitData): string[] {
    const ids = new Set(data.commits.map(c => c.id));
    return seeds.filter(s => !ids.has(s.tip)).map(s => s.name);
  }

  /** Full view result. Mirrors read_git_data. */
  async viewResult(limit = PAGE): Promise<ViewResult> {
    const seeds = await this.laneSeeds();
    const data = await this.buildView(seeds, limit);
    return { data, seeds, staleNames: this.staleSeeds(seeds, data) };
  }

  /** Single-commit seed window (search jump target). Mirrors
   *  read_git_data_from_commit. */
  async viewFromCommit(commitId: string, limit = PAGE): Promise<ViewResult> {
    const r = await gitRaw(this.dir, ['rev-parse', '--verify', '--quiet', `${commitId}^{commit}`]);
    if (r.code !== 0) throw new Error(`Commit not found: ${commitId}`);
    const id = r.stdout.trim();
    const seeds = [{ name: id.slice(0, 7), tip: id, is_remote: false }];
    const data = await this.buildView(seeds, limit);
    return { data, seeds, staleNames: this.staleSeeds(seeds, data) };
  }

  /** View from one branch only. Mirrors read_git_data_from_branch. */
  async viewFromBranch(branchName: string, limit = PAGE): Promise<ViewResult> {
    const all = await this.laneSeeds();
    const seed = all.find(s => s.name === branchName);
    if (!seed) throw new Error(`Branch not found: ${branchName}`);
    const seeds = [seed];
    const data = await this.buildView(seeds, limit);
    return { data, seeds, staleNames: this.staleSeeds(seeds, data) };
  }

  /** Union of the selected branches' lineages. Mirrors filter_by_branches. */
  async filterByBranches(branchNames: string[]): Promise<ViewResult> {
    const all = await this.laneSeeds();
    const selected = all.filter(s => branchNames.includes(s.name));
    const data = await this.buildView(selected, PAGE);
    return { data, seeds: selected, staleNames: this.staleSeeds(selected, data) };
  }

  /** Next older chunk: full walk minus what the session already holds,
   *  appended and re-laid-out as one set (lane ownership is global).
   *  Mirrors load_more. */
  async loadMore(seeds: LaneSeed[], seen: ReadonlySet<string>, existing: CommitNode[], limit = PAGE): Promise<GitData> {
    const chunk = await this.walk(seeds, seen, limit);
    const hasMore = chunk.length === limit;
    for (const c of existing) {
      c.fork_branch_name = null;
      c.merge_branch_name = null;
    }
    const commits = [...existing, ...chunk];
    const mainBranch = this.detectMainBranch(seeds);
    const headId = await this.headOid();
    const headBranch = await this.headBranch();
    const headCount = await this.headCommitCount();
    const { lanes, edges, timeGaps } = computeLayout(commits, seeds, mainBranch, headId);
    return {
      commits,
      edges,
      branches: lanes,
      main_branch: mainBranch,
      time_gaps: timeGaps,
      has_more: hasMore,
      head_branch: headBranch,
      head_commit_count: headCount,
    };
  }

  /** Filter-chip list: branch lanes colored from the built view, then tags
   *  (chips, never lanes). Mirrors get_branch_list. */
  async branchList(view: GitData): Promise<BranchLane[]> {
    const seeds = await this.laneSeeds();
    const colorOf = new Map(view.branches.map(b => [b.name, b.color]));
    const list: BranchLane[] = seeds.map((s, i) => ({
      name: s.name,
      lane_index: i,
      color: colorOf.get(s.name) ?? laneColor(i),
      is_tag: false,
      fork_point: null,
      merged_into: null,
      is_active: true,
      is_remote: s.is_remote,
    }));
    const tagOut = await git(this.dir, ['tag', '--list']);
    const tags = tagOut.split('\n').filter(Boolean).sort();
    for (const tag of tags) {
      list.push({
        name: tag,
        lane_index: list.length,
        color: TAG_COLOR,
        is_tag: true,
        fork_point: null,
        merged_into: null,
        is_active: true,
        is_remote: false,
      });
    }
    return list;
  }

  /** numstat + name-status against the first parent (or the empty tree for
   *  the root commit). Shared by commitDetail and the lazy stat loader. */
  private async diffVsFirstParent(id: string): Promise<{ numstat: string; nameStatus: string }> {
    const p = await gitRaw(this.dir, ['show', '-s', '--format=%P', id]);
    const parents = p.stdout.trim().split(' ').filter(Boolean);
    if (parents.length === 0) {
      return {
        numstat: await git(this.dir, ['diff-tree', '--root', '--numstat', '-r', id]),
        nameStatus: await git(this.dir, ['diff-tree', '--root', '--name-status', '-r', id]),
      };
    }
    return {
      numstat: await git(this.dir, ['diff', '--numstat', parents[0], id]),
      nameStatus: await git(this.dir, ['diff', '--name-status', parents[0], id]),
    };
  }

  /** (additions, deletions) for the stat loader. Mirrors diff_stats. */
  private async diffStats(id: string): Promise<{ additions: number; deletions: number }> {
    const { numstat } = await this.diffVsFirstParent(id);
    let additions = 0, deletions = 0;
    for (const line of numstat.split('\n')) {
      const [a, d] = line.split('\t');
      additions += parseInt(a, 10) || 0; // binary files count 0 like the desktop
      deletions += parseInt(d, 10) || 0;
    }
    return { additions, deletions };
  }

  /** Capped at 150 ids, per the desktop. Mirrors get_commit_stats. */
  async commitStats(ids: string[]): Promise<CommitStat[]> {
    const out: CommitStat[] = [];
    for (const id of ids.slice(0, 150)) {
      try {
        const s = await this.diffStats(id);
        out.push({ id, additions: s.additions, deletions: s.deletions });
      } catch { /* a stat that fails to resolve is skipped, never fatal */ }
    }
    return out;
  }

  /** Full commit detail. NOTE: unlike the desktop's get_commit_detail
   *  (per-file numbers intentionally 0, "left for P1"), the CLI path gets
   *  real per-file +/- for free from --numstat, so the extension shows them.
   *  Mirrors the rest of get_commit_detail. */
  async commitDetail(id: string): Promise<CommitDetail | null> {
    const meta = await gitRaw(this.dir, [
      'show', '-s', `--format=%H%x00%h%x00%an%x00%ae%x00%ct%x00%P%x00%s`, id,
    ]);
    if (meta.code !== 0) return null;
    const f = meta.stdout.replace(/\n$/, '').split('\0');
    const [oid, short, an, ae, ct, parents, subject] = f;
    const fullMessage = await git(this.dir, ['show', '-s', '--format=%B', id]);
    const refs = (await this.refMap()).get(oid) ?? [];
    const { numstat, nameStatus } = await this.diffVsFirstParent(id);

    const statByPath = new Map<string, { additions: number; deletions: number }>();
    let totalA = 0, totalD = 0;
    for (const line of numstat.split('\n')) {
      if (!line) continue;
      const [a, d, ...rest] = line.split('\t');
      const p = rest.join('\t');
      const additions = parseInt(a, 10) || 0;
      const deletions = parseInt(d, 10) || 0;
      statByPath.set(p, { additions, deletions });
      totalA += additions;
      totalD += deletions;
    }
    const files: FileChange[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      const status = parts[0].charAt(0); // R100 -> R
      // Renames: take the NEW path (delta.new_file() in the Rust code).
      const p = status === 'R' ? parts[2] : parts[1];
      const s = statByPath.get(p) ?? { additions: 0, deletions: 0 };
      files.push({ path: p ?? 'unknown', additions: s.additions, deletions: s.deletions, status });
    }

    return {
      id: oid,
      short_id: short,
      message: subject ?? '',
      full_message: fullMessage.replace(/\n$/, ''),
      author_name: an || 'Unknown',
      author_email: ae ?? '',
      timestamp: parseInt(ct, 10) || 0,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      branch_refs: refs,
      files,
      total_additions: totalA,
      total_deletions: totalD,
    };
  }

  /** Patch text for one file in a commit (vs first parent / empty tree),
   *  200KB-capped like the desktop's render_file_patch. */
  async fileDiff(commitId: string, path: string): Promise<string> {
    const p = await gitRaw(this.dir, ['show', '-s', '--format=%P', commitId]);
    const parents = p.stdout.trim().split(' ').filter(Boolean);
    const out = parents.length === 0
      ? await git(this.dir, ['diff-tree', '--root', '-p', commitId, '--', path])
      : await git(this.dir, ['diff', parents[0], commitId, '--', path]);
    return out.length > 200 * 1024 ? out.slice(0, 200 * 1024) : out;
  }

  /** Two-commit compare: numstat + name-status between base and target.
   *  Mirrors compare_detail. */
  async compareDetail(baseOid: string, targetOid: string): Promise<CompareDetail | null> {
    const side = async (oid: string): Promise<CompareSide | null> => {
      const r = await gitRaw(this.dir, ['show', '-s', '--format=%H%x00%h%x00%s%x00%an', oid]);
      if (r.code !== 0) return null;
      const [id, short, subject, author] = r.stdout.replace(/\n$/, '').split('\0');
      return { id, short_id: short, subject: subject ?? '', author: author || 'Unknown' };
    };
    const base = await side(baseOid);
    const target = await side(targetOid);
    if (!base || !target) return null;

    const numstat = await git(this.dir, ['diff', '--numstat', baseOid, targetOid]);
    const nameStatus = await git(this.dir, ['diff', '--name-status', baseOid, targetOid]);
    const statByPath = new Map<string, { additions: number; deletions: number }>();
    let totalA = 0, totalD = 0;
    for (const line of numstat.split('\n')) {
      if (!line) continue;
      const [a, d, ...rest] = line.split('\t');
      const additions = parseInt(a, 10) || 0;
      const deletions = parseInt(d, 10) || 0;
      statByPath.set(rest.join('\t'), { additions, deletions });
      totalA += additions;
      totalD += deletions;
    }
    const files: FileChange[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      const p = status === 'R' ? parts[2] : parts[1];
      const s = statByPath.get(p) ?? { additions: 0, deletions: 0 };
      files.push({ path: p ?? 'unknown', additions: s.additions, deletions: s.deletions, status });
    }
    return { base, target, files, total_additions: totalA, total_deletions: totalD };
  }

  /** Patch text for one file between two commits. Mirrors pair_file_diff. */
  async pairFileDiff(baseOid: string, targetOid: string, path: string): Promise<string> {
    const out = await git(this.dir, ['diff', baseOid, targetOid, '--', path]);
    return out.length > 200 * 1024 ? out.slice(0, 200 * 1024) : out;
  }

  /** Full-history search: substring on subject/author (case-insensitive),
   *  hex prefix >= 4 on the id; newest-first, capped. Mirrors
   *  search_commits. */
  async search(query: string, limit: number, loaded: ReadonlySet<string>): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q || limit === 0) return [];
    const isHex = q.length >= 4 && /^[0-9a-f]+$/.test(q);
    const seeds = await this.laneSeeds();
    const tips = seeds.map(s => s.tip);
    const args = ['log', '--date-order', `--format=%H${US}%s${US}%an${US}%ct${RS}`];
    args.push(...(tips.length > 0 ? tips : ['HEAD']));
    const out = await git(this.dir, args, 60000);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const rec of out.split(RS)) {
      const f = rec.replace(/^\n+/, '').split(US);
      if (f.length < 4) continue;
      const [id, subject, author, ct] = f;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const s = (subject ?? '').toLowerCase();
      const a = (author ?? '').toLowerCase();
      if (!(s.includes(q) || a.includes(q) || (isHex && id.startsWith(q)))) continue;
      hits.push({
        id,
        message: subject ?? '',
        author_name: author || 'Unknown',
        timestamp: parseInt(ct, 10) || 0,
        in_view: loaded.has(id),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Dirty-worktree counts + in-progress merge state. Buckets mirror
   *  worktree_status: "??" = untracked; every other porcelain entry is a
   *  change vs HEAD and counts as modified. */
  async worktreeStatus(): Promise<WorktreeStatus> {
    const out = await git(this.dir, ['status', '--porcelain=v1']);
    let modified = 0, untracked = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('??')) untracked++;
      else modified++;
    }
    const gitDir = (await git(this.dir, ['rev-parse', '--git-dir'])).trim();
    const absGitDir = path.resolve(this.dir, gitDir);
    const inProgress = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
      .some(f => fs.existsSync(path.join(absGitDir, f)));
    return { modified, untracked, merge_in_progress: inProgress };
  }

  /** SAFE branch switch via the system git. Mirrors checkout_branch's
   *  refusal set: merge/cherry-pick/revert in progress, non-local names,
   *  cross-worktree occupancy. git's own checkout then carries compatible
   *  uncommitted changes and refuses conflicts before writing — the same
   *  SAFE semantics the desktop hand-rolls with libgit2. */
  async checkout(name: string): Promise<void> {
    const status = await this.worktreeStatus();
    if (status.merge_in_progress) {
      throw new Error('merge, cherry-pick, or revert in progress');
    }
    // Local branches only: tags and origin/* fail this lookup.
    const exists = await gitRaw(this.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (exists.code !== 0) throw new Error(`Branch not found: ${name}`);

    const selfPath = await this.canonicalPath();
    const family = await this.worktreeFamily();
    for (const m of family) {
      if (m.path === selfPath) continue;
      if (m.head_branch === name) {
        throw new Error(`branch '${name}' is already checked out at '${m.path}'`);
      }
    }
    const r = await gitRaw(this.dir, ['checkout', name]);
    if (r.code !== 0) throw new Error(`Checkout failed${summarizeStderr(r.stderr)}`);
  }

  /** `git fetch --all --quiet`; returns null when clean, else a one-line
   *  stderr summary. Mirrors fetch_remotes (write surface: tracking refs +
   *  objects + FETCH_HEAD only). */
  async fetch(): Promise<string | null> {
    const r = await gitRaw(this.dir, ['fetch', '--all', '--quiet'], 120000);
    if (r.code === 0) return null;
    return `git fetch exited ${r.code}${summarizeStderr(r.stderr)}`;
  }

  /** Worktree family from `git worktree list --porcelain`, main first.
   *  Mirrors worktree_family. */
  async worktreeFamily(): Promise<WorktreeMember[]> {
    const r = await gitRaw(this.dir, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) return [];
    const members: WorktreeMember[] = [];
    let cur: Partial<WorktreeMember> & { branchRef?: string } = {};
    const flush = () => {
      if (!cur.path) return;
      let real = cur.path;
      try { real = fs.realpathSync(cur.path); } catch { /* removed member: keep raw */ }
      members.push({
        name: path.basename(real),
        path: real,
        is_main: members.length === 0, // porcelain lists the main worktree first
        head_branch: cur.branchRef ? cur.branchRef.replace(/^refs\/heads\//, '') : null,
      });
      cur = {};
    };
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        cur = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch ')) {
        cur.branchRef = line.slice('branch '.length);
      } else if (line === '') {
        flush();
      }
    }
    flush();
    return members;
  }
}
