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
  /** Shorthand of the branch HEAD sits on; null while detached (or on an
   *  unborn HEAD). Mirrors models.rs; drives the current-lane marker. */
  head_branch: string | null;
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

/** One full-history search hit (Cmd+F); `in_view` flags membership in the
 *  currently loaded window — outside hits jump via jumpToCommit. */
export interface SearchHit {
  id: string;
  message: string;
  author_name: string;
  timestamp: number;
  in_view: boolean;
}

/** One side of a two-commit compare (enough to head the compare panel);
 *  mirrors models.rs. */
export interface CompareSide {
  id: string;
  short_id: string;
  subject: string;
  author: string;
}

/** Two-commit compare (base -> target): per-file changes with real
 *  per-file +/- numbers (unlike CommitDetail, whose per-file numbers stay
 *  0) plus running totals; mirrors models.rs. */
export interface CompareDetail {
  base: CompareSide;
  target: CompareSide;
  files: FileChange[];
  total_additions: number;
  total_deletions: number;
}

/** Worktree preflight for the checkout confirm dialog; mirrors models.rs. */
export interface WorktreeStatus {
  modified: number;
  untracked: number;
  merge_in_progress: boolean;
}

/** Ack returned by checkoutBranch; mirrors models.rs. Carries no view
 *  data on purpose: the repo-changed watcher path is the only rebuilder. */
export interface CheckoutAck {
  branch: string;
}

// --- Integrated terminal (bottom panel); mirrors models.rs ---
// Event names: "terminal-output" (TerminalOutput), "terminal-exit"
// (TerminalExit), "repo-changed" (plain string path).

/** Live terminal session handle returned by terminalSpawn. */
export interface TerminalInfo {
  id: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

/** PTY output chunk; `data` is base64 (raw bytes, may split UTF-8). */
export interface TerminalOutput {
  id: number;
  data: string;
}

/** Emitted when the shell child process exits. */
export interface TerminalExit {
  id: number;
}
