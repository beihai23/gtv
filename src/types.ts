export interface BranchRef {
  name: string;
  is_remote: boolean;
  is_tag: boolean;
  color: string;
}

export interface CommitNode {
  id: string;
  short_id: string;
  message: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string[];
  branch_refs: BranchRef[];
  fork_branch_name: string | null;
  merge_branch_name: string | null;
  lane_owner: string;
  is_head: boolean;
  is_key: boolean;
  additions: number;
  deletions: number;
  x: number;
  y: number;
  lane: number;
}

export interface CommitEdge {
  from: string;
  to: string;
  edge_type: 'Direct' | 'Branch' | 'Merge';
}

export interface BranchLane {
  name: string;
  lane_index: number;
  color: string;
  is_tag: boolean;
  fork_point: string | null;
  merged_into: string | null;
  is_active: boolean;
}

export interface TimeGap {
  t_start: number;
  t_end: number;
  x_start: number;
  x_end: number;
}

export interface GitData {
  commits: CommitNode[];
  edges: CommitEdge[];
  branches: BranchLane[];
  main_branch: string;
  time_gaps: TimeGap[];
  /** True while older history can still be paged in via loadOlderCommits. */
  has_more: boolean;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface PatchLink {
  from: string;
  to: string;
  kind: string; // 'rebase' | 'cherry-pick'
}

/** Diff volume of one commit, fetched lazily after the view renders. */
export interface CommitStat {
  id: string;
  additions: number;
  deletions: number;
}

export interface CommitDetail {
  id: string;
  short_id: string;
  message: string;
  full_message: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string[];
  branch_refs: BranchRef[];
  files: FileChange[];
  total_additions: number;
  total_deletions: number;
}
