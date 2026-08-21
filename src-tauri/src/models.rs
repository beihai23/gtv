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
