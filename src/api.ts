import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  GitData, CommitDetail, BranchLane, PatchLink, CommitStat, SearchHit, TerminalInfo,
  WorktreeStatus, CheckoutAck, CompareDetail, OpenedRepo,
} from './types';

// Multi-repo-tabs Task 5: this file is THE backend contract surface. Every
// repo-scoped command takes repoId as its first parameter (the session
// registry routes on it); the old implicit "current repo" wrappers are
// gone. The backend owns dedup: openRepository on an already-open
// canonical path returns the EXISTING repo_id and current view
// (already_open: true) instead of rebuilding anything.

/// Picker + open in one step: returns the OpenedRepo the backend
/// registered, or null when the dialog was cancelled. (The App tab shell
/// prefers running the dialog itself so every open funnels through its
/// single openTab(path) entry; this wrapper stays part of the contract
/// surface.)
export async function selectAndOpenRepository(includeStale: boolean): Promise<OpenedRepo | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select Git Repository',
  });

  if (selected && typeof selected === 'string') {
    return openRepository(selected, includeStale);
  }
  return null;
}

/// Open (or dedup-activate) a repository. The backend canonicalizes the
/// path: a hit on an already-open session reactivates it (already_open:
/// true -- view/session/baseline untouched, family re-enumerated), a
/// fresh path registers a new session. Either way the opened repo becomes
/// the ACTIVE one (the auto-fetch target).
export async function openRepository(path: string, includeStale: boolean): Promise<OpenedRepo> {
  return invoke<OpenedRepo>('open_repository', { path, includeStale });
}

/// Remove a repository's session (tab close). The backend drops the
/// session AND kills that tab's terminal with it.
export async function closeRepository(repoId: number): Promise<void> {
  return invoke<void>('close_repository', { repoId });
}

/// Mark a repo as the active tab (auto-fetch target); called on tab
/// switches.
export async function setActiveRepository(repoId: number): Promise<void> {
  return invoke<void>('set_active_repository', { repoId });
}

/// Settings toggle for the 60 s auto-fetch thread (no immediate-trigger
/// semantics: the next tick picks the new value up).
export async function setAutoFetch(enabled: boolean): Promise<void> {
  return invoke<void>('set_auto_fetch', { enabled });
}

/// Rebuild one repo's view under a new include-stale setting WITHOUT
/// touching its terminal, watcher baseline, or family snapshot: the dedup
/// semantics forbid re-open, so the settings toggle -- and any same-policy
/// full rebuild, e.g. the repo-changed refresh -- goes through here.
export async function setIncludeStale(repoId: number, enabled: boolean): Promise<GitData> {
  return invoke<GitData>('set_include_stale', { repoId, enabled });
}

export async function getCommitDetail(repoId: number, commitId: string): Promise<CommitDetail> {
  return invoke<CommitDetail>('get_commit_detail', { repoId, commitId });
}

export async function getFileDiff(repoId: number, commitId: string, path: string): Promise<string> {
  return invoke<string>('get_file_diff', { repoId, commitId, path });
}

/// Two-commit compare (base -> target): file list with real per-file
/// +/- numbers, running totals, and both-side summaries. Read-only.
export async function getCompareDetail(repoId: number, base: string, target: string): Promise<CompareDetail> {
  return invoke<CompareDetail>('get_compare_detail', { repoId, base, target });
}

/// Unified diff patch text for one file between two commits (base ->
/// target); same truncation and binary handling as getFileDiff.
export async function getPairFileDiff(repoId: number, base: string, target: string, path: string): Promise<string> {
  return invoke<string>('get_pair_file_diff', { repoId, base, target, path });
}

export async function isValidGitRepo(path: string): Promise<boolean> {
  return invoke<boolean>('is_valid_git_repo', { path });
}

export async function getBranchList(repoId: number): Promise<BranchLane[]> {
  return invoke<BranchLane[]>('get_branch_list', { repoId });
}

export async function switchBranch(repoId: number, branchName: string): Promise<GitData> {
  return invoke<GitData>('switch_branch', { repoId, branchName });
}

/// Worktree preflight for the checkout confirm dialog (modified/untracked
/// counts + merge-in-progress flag). Read-only.
export async function getWorktreeStatus(repoId: number): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>('get_worktree_status', { repoId });
}

/// SAFE checkout of a local branch -- the backend's only worktree-write
/// path. The ack carries no view data: the repo-changed watcher rebuilds
/// the view.
export async function checkoutBranch(repoId: number, branch: string): Promise<CheckoutAck> {
  return invoke<CheckoutAck>('checkout_branch', { repoId, branch });
}

export async function filterByBranches(repoId: number, branchNames: string[]): Promise<GitData> {
  return invoke<GitData>('filter_by_branches', { repoId, branchNames });
}

export async function getPatchLinks(repoId: number): Promise<PatchLink[]> {
  return invoke<PatchLink[]>('get_patch_links', { repoId });
}

/// Diff volume for node sizing, loaded lazily after the first paint.
/// Returns an empty list when the backend has nothing (e.g. browser mock).
export async function getCommitStats(repoId: number, commitIds: string[]): Promise<CommitStat[]> {
  const stats = await invoke<CommitStat[] | null>('get_commit_stats', { repoId, commitIds });
  return stats ?? [];
}

/// Page in the next chunk of older history (replaces the whole view;
/// the timeline keeps the viewport anchored). Null in the browser mock.
export async function loadOlderCommits(repoId: number): Promise<GitData | null> {
  return invoke<GitData | null>('load_older_commits', { repoId });
}

/// Recent backend log lines for the issue-report dialog. Falls back to an
/// empty list when the backend returns null (e.g. browser mock preview).
export async function getRecentLogs(): Promise<string[]> {
  const logs = await invoke<string[] | null>('get_recent_logs');
  return logs ?? [];
}

export async function jumpToCommit(repoId: number, commitId: string): Promise<GitData> {
  return invoke<GitData>('jump_to_commit', { repoId, commitId });
}

export async function searchCommits(repoId: number, query: string, limit: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search_commits', { repoId, query, limit });
}

// --- Integrated terminal (bottom panel); one session per open repo ---

/// Spawn (or re-attach to) the shell session in the given repo. Null in
/// the browser mock (invoke default) — callers treat that as "terminal
/// unavailable" and hide the panel affordances.
export async function terminalSpawn(repoId: number, cols: number, rows: number): Promise<TerminalInfo | null> {
  return invoke<TerminalInfo | null>('terminal_spawn', { repoId, cols, rows });
}

export async function terminalWrite(repoId: number, data: string): Promise<void> {
  return invoke<void>('terminal_write', { repoId, data });
}

export async function terminalResize(repoId: number, cols: number, rows: number): Promise<void> {
  return invoke<void>('terminal_resize', { repoId, cols, rows });
}

export async function terminalKill(repoId: number): Promise<void> {
  return invoke<void>('terminal_kill', { repoId });
}
