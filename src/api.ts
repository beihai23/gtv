import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { GitData, CommitDetail, BranchLane, PatchLink, CommitStat, SearchHit, TerminalInfo, WorktreeStatus, CheckoutAck, CompareDetail } from './types';

export async function selectAndOpenRepository(includeStale: boolean): Promise<GitData | null> {
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

export async function openRepository(path: string, includeStale: boolean): Promise<GitData> {
  return invoke<GitData>('open_repository', { path, includeStale });
}

export async function getCommitDetail(commitId: string): Promise<CommitDetail> {
  return invoke<CommitDetail>('get_commit_detail', { commitId });
}

export async function getFileDiff(commitId: string, path: string): Promise<string> {
  return invoke<string>('get_file_diff', { commitId, path });
}

/// Two-commit compare (base -> target): file list with real per-file
/// +/- numbers, running totals, and both-side summaries. Read-only.
export async function getCompareDetail(base: string, target: string): Promise<CompareDetail> {
  return invoke<CompareDetail>('get_compare_detail', { base, target });
}

/// Unified diff patch text for one file between two commits (base ->
/// target); same truncation and binary handling as getFileDiff.
export async function getPairFileDiff(base: string, target: string, path: string): Promise<string> {
  return invoke<string>('get_pair_file_diff', { base, target, path });
}

export async function getCurrentPath(): Promise<string | null> {
  return invoke<string | null>('get_current_path');
}

export async function getCurrentBranch(): Promise<string | null> {
  return invoke<string | null>('get_current_branch');
}

export async function isValidGitRepo(path: string): Promise<boolean> {
  return invoke<boolean>('is_valid_git_repo', { path });
}

export async function getBranchList(): Promise<BranchLane[]> {
  return invoke<BranchLane[]>('get_branch_list');
}

export async function switchBranch(branchName: string): Promise<GitData> {
  return invoke<GitData>('switch_branch', { branchName });
}

/// Worktree preflight for the checkout confirm dialog (modified/untracked
/// counts + merge-in-progress flag). Read-only.
export async function getWorktreeStatus(): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>('get_worktree_status');
}

/// SAFE checkout of a local branch -- the backend's only write path. The
/// ack carries no view data: the repo-changed watcher rebuilds the view.
export async function checkoutBranch(branch: string): Promise<CheckoutAck> {
  return invoke<CheckoutAck>('checkout_branch', { branch });
}

export async function filterByBranches(branchNames: string[]): Promise<GitData> {
  return invoke<GitData>('filter_by_branches', { branchNames });
}

export async function getPatchLinks(): Promise<PatchLink[]> {
  return invoke<PatchLink[]>('get_patch_links');
}

/// Diff volume for node sizing, loaded lazily after the first paint.
/// Returns an empty list when the backend has nothing (e.g. browser mock).
export async function getCommitStats(commitIds: string[]): Promise<CommitStat[]> {
  const stats = await invoke<CommitStat[] | null>('get_commit_stats', { commitIds });
  return stats ?? [];
}

/// Page in the next chunk of older history (replaces the whole view;
/// the timeline keeps the viewport anchored). Null in the browser mock.
export async function loadOlderCommits(): Promise<GitData | null> {
  return invoke<GitData | null>('load_older_commits');
}

/// Recent backend log lines for the issue-report dialog. Falls back to an
/// empty list when the backend returns null (e.g. browser mock preview).
export async function getRecentLogs(): Promise<string[]> {
  const logs = await invoke<string[] | null>('get_recent_logs');
  return logs ?? [];
}

export async function jumpToCommit(commitId: string): Promise<GitData> {
  return invoke<GitData>('jump_to_commit', { commitId });
}

export async function searchCommits(query: string, limit: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search_commits', { query, limit });
}

// --- Integrated terminal (bottom panel) ---

/// Spawn (or re-attach to) the shell session in the current repo. Null in
/// the browser mock (invoke default) — callers treat that as "terminal
/// unavailable" and hide the panel affordances.
export async function terminalSpawn(cols: number, rows: number): Promise<TerminalInfo | null> {
  return invoke<TerminalInfo | null>('terminal_spawn', { cols, rows });
}

export async function terminalWrite(data: string): Promise<void> {
  return invoke<void>('terminal_write', { data });
}

export async function terminalResize(cols: number, rows: number): Promise<void> {
  return invoke<void>('terminal_resize', { cols, rows });
}

export async function terminalKill(): Promise<void> {
  return invoke<void>('terminal_kill');
}
