use serde::{Deserialize, Serialize};

/// Commit node in the timeline
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitNode {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub branch_refs: Vec<BranchRef>,
    pub fork_branch_name: Option<String>,
    pub merge_branch_name: Option<String>,
    /// Name of the lane that owns this commit (assigned by layout).
    #[serde(default)]
    pub lane_owner: String,
    /// True when this commit is the current HEAD.
    #[serde(default)]
    pub is_head: bool,
    /// True when this commit survives smart compression (lane birth/tip,
    /// merge source or target, tagged, HEAD...).
    #[serde(default)]
    pub is_key: bool,
    /// Diff volume vs first parent (filled lazily via get_commit_stats).
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
    // Layout coordinates (calculated later)
    pub x: f64,
    pub y: f64,
    pub lane: i32,
}

/// Branch/tag reference pointing to a commit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchRef {
    pub name: String,
    pub is_remote: bool,
    pub is_tag: bool,
    pub color: String,
}

/// Connection edge between commits
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEdge {
    pub from: String,
    pub to: String,
    pub edge_type: EdgeType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EdgeType {
    Direct, // Same branch, consecutive
    Branch, // Branch creation
    Merge,  // Merge commit
}

/// Branch lane for vertical distribution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchLane {
    pub name: String,
    pub lane_index: i32,
    pub color: String,
    pub is_tag: bool,
    /// Commit where this lane was born (on the parent lane). None for main.
    #[serde(default)]
    pub fork_point: Option<String>,
    /// Merge commit that absorbed this lane's tip. None if never merged.
    #[serde(default)]
    pub merged_into: Option<String>,
    /// Whether the branch ref still exists (false = ghost lane).
    #[serde(default)]
    pub is_active: bool,
}

/// Complete Git data for visualization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitData {
    pub commits: Vec<CommitNode>,
    pub edges: Vec<CommitEdge>,
    pub branches: Vec<BranchLane>,
    pub main_branch: String,
    /// Folded empty time gaps on the x-axis (axis breaks), sorted by time.
    #[serde(default)]
    pub time_gaps: Vec<TimeGap>,
    /// True while older history beyond the loaded window can still be
    /// paged in via load_older_commits.
    #[serde(default)]
    pub has_more: bool,
    /// Shorthand of the branch HEAD currently sits on; None while detached
    /// (or on an unborn HEAD). Powers the current-lane marker; unrelated to
    /// layout's is_head, which marks the HEAD commit itself.
    #[serde(default)]
    pub head_branch: Option<String>,
}

/// An anomalous empty time range that was folded to a fixed pixel width.
/// Without folding, one commit with a bogus future/past timestamp stretches
/// the time-proportional x-axis by tens of thousands of pixels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeGap {
    /// Folded-away time range (unix seconds).
    pub t_start: i64,
    pub t_end: i64,
    /// Final x range the folded gap occupies on screen.
    pub x_start: f64,
    pub x_end: f64,
}

/// Layout configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutConfig {
    pub node_spacing_x: f64,
    pub lane_height: f64,
    pub main_branch_lane: i32,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            node_spacing_x: 80.0,
            lane_height: 60.0,
            main_branch_lane: 0,
        }
    }
}

/// File change in a commit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub additions: i32,
    pub deletions: i32,
    pub status: String,
}

/// A "same change, different commit" link, detected by normalized patch
/// hash (git patch-id style: added/removed lines + file paths, no line
/// numbers, no context). kind is "rebase" when two lanes share a run of
/// consecutive matching commits, otherwise "cherry-pick".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchLink {
    pub from: String,
    pub to: String,
    pub kind: String,
}

/// Diff volume of one commit, computed lazily after the view renders —
/// one tree diff per commit is too expensive for the open path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitStat {
    pub id: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Detailed commit info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub full_message: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub branch_refs: Vec<BranchRef>,
    pub files: Vec<FileChange>,
    /// Whole-commit diff totals (per-file split is P1).
    #[serde(default)]
    pub total_additions: i32,
    #[serde(default)]
    pub total_deletions: i32,
}

/// One side of a two-commit compare: just enough to head the compare
/// panel (full id, short id, subject, author).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareSide {
    pub id: String,
    pub short_id: String,
    pub subject: String,
    pub author: String,
}

/// Two-commit compare (base -> target): the file list of the two-tree
/// diff with REAL per-file additions/deletions (get_commit_detail
/// deliberately leaves its per-file numbers at 0), plus the running
/// totals and both-side summaries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareDetail {
    pub base: CompareSide,
    pub target: CompareSide,
    pub files: Vec<FileChange>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

/// One full-history search hit (Cmd+F). `in_view` tells the frontend
/// whether the commit is inside the currently loaded window — hits outside
/// it jump via `jump_to_commit` instead of in-graph focus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub message: String,
    pub author_name: String,
    pub timestamp: i64,
    pub in_view: bool,
}

/// Worktree preflight for the checkout confirm dialog: how many paths
/// carry uncommitted changes vs HEAD, staged or not (edits, deletions,
/// renames, typechanges), how many paths are untracked, and whether a
/// merge, cherry-pick, or revert is in progress (checkout refuses while
/// one is).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeStatus {
    pub modified: usize,
    pub untracked: usize,
    pub merge_in_progress: bool,
}

/// Ack returned by checkout_branch. Deliberately carries no view data:
/// the watcher's repo-changed -> refresh chain is the only view rebuilder,
/// so a checkout can never race a second rebuild.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutAck {
    pub branch: String,
}

/// One member of a worktree family: the main repository (is_main) or one
/// linked worktree sharing the same common dir. Metadata only — members
/// are opened lazily by the frontend's second-level tabs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeMember {
    pub name: String,
    pub path: String,
    pub is_main: bool,
}

/// open_repository's return: the view data plus the registry identity the
/// frontend needs — which tab this is (repo_id), whether the open was a
/// dedup hit on an already-open session, and the family metadata for the
/// second-level tabs (commondir = canonical family key, shared by every
/// member of one worktree family).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenedRepo {
    pub repo_id: u64,
    pub already_open: bool,
    pub commondir: String,
    pub family: Vec<WorktreeMember>,
    pub data: GitData,
}

/// "repo-changed" payload: which registered repository moved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoChanged {
    pub repo_id: u64,
    pub path: String,
}

// --- Integrated terminal (bottom panel) ---
// Event names used with `emit`/`listen`: "terminal-output" (TerminalOutput),
// "terminal-exit" (TerminalExit), "repo-changed" (RepoChanged, emitted by
// the watcher poller in watcher.rs).

/// Live terminal session handle returned by terminal_spawn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: u64,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

/// PTY output chunk; `data` is base64 (raw bytes, may split UTF-8 sequences).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub id: u64,
    pub data: String,
}

/// Emitted when the shell child process exits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalExit {
    pub id: u64,
}
