// Session registry + command dispatch — the extension-host mirror of the
// desktop's commands.rs AppState. One Engine per webview panel; sessions
// keyed by repo_id with the same dedup rules (canonical path →
// already_open reactivation, never a rebuilt session).

import { RepoReader, type ViewResult } from './reader';
import type { LaneSeed } from './layout';
import type { GitData, OpenedRepo } from '../../../src/types';

const PAGE = 2000;

interface Session {
  reader: RepoReader;
  path: string; // canonical
  view: GitData;
  /** Pagination state (ViewSession in the desktop): the seed set the view
   *  was built from, the stale names at build time, and every oid loaded
   *  so far (load_more hides these from the next walk). */
  seeds: LaneSeed[];
  staleNames: string[];
  seen: Set<string>;
  includeStale: boolean;
  /** Watcher baseline: set at open so the first poll never fires. */
  baseline?: string;
}

export class Engine {
  private repos = new Map<number, Session>();
  private nextId = 1;
  private active = 0;
  private autoFetch = true;
  /** Set by the host: (event, payload) => void. The watcher emits
   *  "repo-changed" through it. */
  emit: (event: string, payload: unknown) => void = () => {};

  private session(repoId: number): Session {
    const s = this.repos.get(repoId);
    if (!s) throw new Error('No repository opened');
    return s;
  }

  private storeView(session: Session, result: ViewResult, includeStale: boolean): GitData {
    const seeds = includeStale
      ? result.seeds
      : result.seeds.filter(s => !result.staleNames.includes(s.name));
    session.seeds = seeds;
    session.staleNames = result.staleNames;
    session.seen = new Set(result.data.commits.map(c => c.id));
    session.view = result.data;
    return result.data;
  }

  async openRepository(path: string, includeStale: boolean): Promise<OpenedRepo> {
    const reader = await RepoReader.open(path);
    const canonical = await reader.canonicalPath();

    // Dedup: same canonical path reactivates the existing session with its
    // CURRENT view; only the family snapshot refreshes.
    for (const [id, s] of this.repos) {
      if (s.path === canonical) {
        this.active = id;
        const family = await s.reader.worktreeFamily();
        const commondir = await s.reader.commondir();
        return { repo_id: id, already_open: true, commondir, family, data: s.view };
      }
    }

    const result = await reader.viewResult(PAGE);
    const commondir = await reader.commondir();
    const family = await reader.worktreeFamily();
    const repoId = this.nextId++;
    const session: Session = {
      reader,
      path: canonical,
      view: result.data,
      seeds: [],
      staleNames: [],
      seen: new Set(),
      includeStale,
      baseline: await reader.fingerprint(),
    };
    this.repos.set(repoId, session);
    this.storeView(session, result, includeStale);
    this.active = repoId;
    return { repo_id: repoId, already_open: false, commondir, family, data: result.data };
  }

  closeRepository(repoId: number): void {
    if (!this.repos.delete(repoId)) throw new Error('No repository opened');
    if (this.active === repoId) this.active = 0;
  }

  setActiveRepository(repoId: number): void {
    if (!this.repos.has(repoId)) throw new Error('No repository opened');
    this.active = repoId;
  }

  setAutoFetch(enabled: boolean): void {
    this.autoFetch = enabled;
  }

  /** Auto-fetch tick target; the host polls this. Mirrors the desktop's
   *  fetcher: active tab only, and only when the setting is on. */
  autoFetchTarget(): number {
    return this.autoFetch ? this.active : 0;
  }

  async refreshRepository(repoId: number): Promise<GitData> {
    const s = this.session(repoId);
    const result = await s.reader.viewResult(PAGE);
    // Never writes include_stale (the single-writer pin from the desktop).
    return this.storeView(s, result, s.includeStale);
  }

  async fetchRepository(repoId: number): Promise<string | null> {
    return this.session(repoId).reader.fetch();
  }

  async setIncludeStale(repoId: number, enabled: boolean): Promise<GitData> {
    const s = this.session(repoId);
    s.includeStale = enabled;
    return this.refreshRepository(repoId);
  }

  async loadOlderCommits(repoId: number): Promise<GitData | null> {
    const s = this.session(repoId);
    if (!s.view.has_more) return null;
    const data = await s.reader.loadMore(s.seeds, s.seen, s.view.commits, PAGE);
    s.view = data;
    s.seen = new Set(data.commits.map(c => c.id));
    return data;
  }

  async jumpToCommit(repoId: number, commitId: string): Promise<GitData> {
    const s = this.session(repoId);
    const result = await s.reader.viewFromCommit(commitId, PAGE);
    // Explicit user action: stale policy does not apply (desktop parity).
    return this.storeView(s, result, true);
  }

  async switchBranch(repoId: number, branchName: string): Promise<GitData> {
    const s = this.session(repoId);
    const result = await s.reader.viewFromBranch(branchName, PAGE);
    return this.storeView(s, result, true);
  }

  async filterByBranches(repoId: number, branchNames: string[]): Promise<GitData> {
    const s = this.session(repoId);
    const result = await s.reader.filterByBranches(branchNames);
    return this.storeView(s, result, true);
  }

  // --- thin read pass-throughs -------------------------------------------

  getBranchList(repoId: number) {
    const s = this.session(repoId);
    return s.reader.branchList(s.view);
  }
  getCommitDetail(repoId: number, commitId: string) {
    return this.session(repoId).reader.commitDetail(commitId);
  }
  getFileDiff(repoId: number, commitId: string, path: string) {
    return this.session(repoId).reader.fileDiff(commitId, path);
  }
  getCompareDetail(repoId: number, base: string, target: string) {
    return this.session(repoId).reader.compareDetail(base, target);
  }
  getPairFileDiff(repoId: number, base: string, target: string, path: string) {
    return this.session(repoId).reader.pairFileDiff(base, target, path);
  }
  getCommitStats(repoId: number, commitIds: string[]) {
    return this.session(repoId).reader.commitStats(commitIds);
  }
  searchCommits(repoId: number, query: string, limit: number) {
    const s = this.session(repoId);
    return s.reader.search(query, limit, s.seen);
  }
  getWorktreeStatus(repoId: number) {
    return this.session(repoId).reader.worktreeStatus();
  }
  async checkoutBranch(repoId: number, branch: string) {
    await this.session(repoId).reader.checkout(branch);
    return { branch };
  }
  listWorktreeMembers(repoId: number) {
    return this.session(repoId).reader.worktreeFamily();
  }
  isValidGitRepo(path: string) {
    return RepoReader.isValid(path);
  }

  /** Watcher tick: fingerprint every open session, emit repo-changed for
   *  the ones that moved. The host calls this on its own interval; there
   *  is no baseline CAS here (the desktop's CAS guards a shared registry
   *  against racing polls — a single interval loop cannot race itself). */
  async pollFingerprints(): Promise<void> {
    for (const [id, s] of this.repos) {
      try {
        const fp = await s.reader.fingerprint();
        if (s.baseline === undefined) {
          s.baseline = fp;
        } else if (s.baseline !== fp) {
          s.baseline = fp;
          this.emit('repo-changed', { repo_id: id, path: s.path });
        }
      } catch { /* a repo mid-replacement is quiet; the next tick retries */ }
    }
  }
}
