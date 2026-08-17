import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { GitData, CommitDetail, BranchLane } from './types';

export async function selectAndOpenRepository(): Promise<GitData | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select Git Repository',
  });

  if (selected && typeof selected === 'string') {
    return openRepository(selected);
  }
  return null;
}

export async function openRepository(path: string): Promise<GitData> {
  return invoke<GitData>('open_repository', { path });
}

export async function getCommitDetail(commitId: string): Promise<CommitDetail> {
  return invoke<CommitDetail>('get_commit_detail', { commitId });
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
