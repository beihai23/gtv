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
}

/// Complete Git data for visualization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitData {
    pub commits: Vec<CommitNode>,
    pub edges: Vec<CommitEdge>,
    pub branches: Vec<BranchLane>,
    pub main_branch: String,
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
}
