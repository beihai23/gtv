import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { GitData, CommitDetail, BranchLane, PatchLink, CommitStat } from './types';

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
