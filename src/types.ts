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

export interface GitData {
  commits: CommitNode[];
  edges: CommitEdge[];
  branches: BranchLane[];
  main_branch: string;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: string;
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
