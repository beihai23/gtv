# M1.3 提交搜索定位补全 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd+F 搜索扩展到 message/author 且覆盖全历史（含未加载窗口），范围外命中一键跳转到"从该提交查看"视图；任意提交从键入到定位 < 2 秒。

**Architecture:** 混合双源：前端即时搜已加载范围（`src/locate.ts` 纯函数），200ms 防抖后新增只读后端命令 `search_commits`（全量 revwalk 子串匹配，返回带 `in_view` 标志）补全合并；`in_view=false` 的命中走第二个新命令 `jump_to_commit`（单种子 2000 窗口，照 `switch_branch` 模式）。

**Tech Stack:** Rust/git2（后端两条命令）、React 19 + TS strict（App 接线）、vitest（locate.ts 纯函数）、mock.html + 浏览器（E2E）。

**Spec:** `docs/superpowers/specs/2026-08-28-commit-search-design.md`（冲突时以 spec 为准；本计划将 spec §4.4 的"footer 提示全史命中总数"细化为 ≥limit 时提示「50+ 条」——后端截断在 limit，真实总数不可知）

## Global Constraints

- 只读红线：两条新命令只 walk/diff，**绝不写仓库**。
- IPC 契约（AGENTS.md）：`models.rs` 与 `src/types.ts` 两侧同步加 `SearchHit`（snake_case 字段），命令在 `lib.rs` invoke_handler 与 `src/api.ts` 两侧同步注册/包装。
- Rust 命令无默认参数：前端调用 `searchCommits(query, 50)`。
- TypeScript strict + noUnusedLocals/noUnusedParameters 门禁：每任务完成时 `npm run build` 必过；`npm test` 保持全绿（M1.2 起 20 用例）。
- 后端测试直接测 `GitReader` 方法（无 Tauri harness），照 `tests/pagination.rs` 的 git-CLI 建仓模式；fixture 必须钉 GIT_AUTHOR_DATE/GIT_COMMITTER_DATE（M1.2 教训：`git merge`/`git commit` 都要吃日期）。
- 匹配语义：query trim + 小写化；summary 或 author_name 子串；query 为 ≥4 位 hex 时同时比对 commit id 前缀；命中按时间倒序，取满 limit 即停。
- i18n：en/zh 两侧字典同步；删除不再成立的 `locateScopeHint`（"仅搜索已加载范围"在本 arc 后为假）。
- 每个任务 commit trailer 一块：`Backstory: docs/work-backstory/commit-search-m1-3.md` 紧贴 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（无空行），Co-Authored-By 最后。
- 代码注释/commit message 英文（ASCII 标点）；docs/ 下中文。

---

### Task 1: 后端 `search_commits`（模型 + 纯函数 + 命令 + TS 镜像 + Rust 测试）

**Files:**
- Modify: `src-tauri/src/models.rs`（文件末尾加 SearchHit）
- Modify: `src-tauri/src/git_reader.rs`（GitReader impl 加 search_commits 方法）
- Modify: `src-tauri/src/commands.rs`（新命令）
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册）
- Modify: `src/types.ts`（SearchHit 镜像）
- Modify: `src/api.ts`（searchCommits 包装）
- Create: `src-tauri/tests/search.rs`

**Interfaces:**
- Consumes: `GitReader::collect_lane_seeds`（私有，同 impl 内可调）、`walk_commits` 的 revwalk 模式。
- Produces（后续任务依赖的精确签名）:
  - Rust: `pub struct SearchHit { pub id: String, pub message: String, pub author_name: String, pub timestamp: i64, pub in_view: bool }`；`GitReader::search_commits(&self, query: &str, limit: usize, loaded: &HashSet<String>) -> Result<Vec<SearchHit>, String>`
  - TS: `export interface SearchHit { id: string; message: string; author_name: string; timestamp: number; in_view: boolean; }`；`export async function searchCommits(query: string, limit: number): Promise<SearchHit[]>`

- [ ] **Step 1: 写失败测试 `src-tauri/tests/search.rs`**

```rust
//! Full-history commit search: case-insensitive substring match on commit
//! subject or author name (plus commit-id prefix for hex queries), newest
//! first, capped at `limit`. `in_view` flags membership in the caller's
//! loaded window (pagination session).

use gtv_lib::git_reader::GitReader;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str], date: &str) {
    let status = Command::new("git")
        .args(["-c", "user.email=gtv@gtv.local", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .current_dir(dir)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed", args);
}

/// Commit with an explicit author (the default helper pins gtv; tests need
/// distinct authors to exercise author matching).
fn commit_as(dir: &Path, author: &str, msg: &str, date: &str) {
    git(
        dir,
        &[
            "-c", &format!("user.name={}", author),
            "commit", "--allow-empty", "-m", msg,
        ],
        date,
    );
}

fn commit(dir: &Path, msg: &str, date: &str) {
    commit_as(dir, "gtv", msg, date);
}

fn day(day: u32) -> String {
    format!("2020-01-{:02}T00:00:00+00:00", day)
}

fn git_sha(dir: &Path, rev: &str) -> String {
    let out = Command::new("git")
        .args(["rev-parse", rev])
        .current_dir(dir)
        .output()
        .expect("failed to spawn git rev-parse");
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// main: c1..c6 (Jan 1..6). Mixed-case subjects and authors on purpose.
fn build_fixture(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).expect("create temp dir");
    git(dir, &["init", "-b", "main"], &day(1));
    commit(dir, "c1 initial import", &day(1));
    commit_as(dir, "Alice", "Fix Login Bug", &day(2));
    commit_as(dir, "alice", "add settings page", &day(3));
    commit(dir, "c4 refactor core", &day(4));
    commit_as(dir, "Bob", "fix login timeout", &day(5));
    commit(dir, "c6 release notes", &day(6));
}

#[test]
fn search_matches_subject_and_author_case_insensitively() {
    let dir = std::env::temp_dir().join(format!("gtv-search-{}", std::process::id()));
    build_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    // Subject match, mixed case both directions.
    let hits = reader.search_commits("login", 50, &empty).expect("search");
    let msgs: Vec<&str> = hits.iter().map(|h| h.message.as_str()).collect();
    assert_eq!(msgs.len(), 2, "Fix Login Bug + fix login timeout: {:?}", msgs);

    // Author match (case-insensitive): Alice and alice are distinct strings.
    let hits = reader.search_commits("alice", 50, &empty).expect("search");
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.author_name.to_lowercase() == "alice"));

    // No match -> empty.
    assert!(reader.search_commits("zzz-nothing", 50, &empty).unwrap().is_empty());

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_returns_newest_first_and_respects_limit() {
    let dir = std::env::temp_dir().join(format!("gtv-search-limit-{}", std::process::id()));
    build_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    // "c" matches 4 subjects: c6 release notes, fix login timeout,
    // c4 refactor core, c1 initial import (newest first).
    let all = reader.search_commits("c", 50, &empty).expect("search");
    assert_eq!(all.len(), 4);
    // Walk order is TIME|TOPO newest-first, so hits are newest-first.
    let ts: Vec<i64> = all.iter().map(|h| h.timestamp).collect();
    let mut sorted = ts.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(ts, sorted);

    let capped = reader.search_commits("c", 2, &empty).expect("search");
    assert_eq!(capped.len(), 2);
    assert_eq!(capped[0].timestamp, all[0].timestamp, "capped keeps the newest");

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_hash_prefix_and_in_view_flag() {
    let dir = std::env::temp_dir().join(format!("gtv-search-hash-{}", std::process::id()));
    build_fixture(&dir);
    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let c1 = git_sha(&dir, "HEAD~5");
    let prefix = &c1[..6];

    // Hash prefix (>=4 hex) finds the commit even with no text match.
    let empty = HashSet::new();
    let hits = reader.search_commits(prefix, 50, &empty).expect("search");
    assert!(hits.iter().any(|h| h.id == c1), "prefix {} must hit c1", prefix);

    // in_view: open a small window (newest 3 = c6 / timeout / c4), then
    // search "c" (4 hits) — the window's 3 are in_view, only c1 is not.
    let window = reader.read_git_data(3).expect("open window");
    let loaded: HashSet<String> = window.data.commits.iter().map(|c| c.id.clone()).collect();
    let hits = reader.search_commits("c", 50, &loaded).expect("search");
    assert_eq!(hits.len(), 4);
    let in_view_count = hits.iter().filter(|h| h.in_view).count();
    assert_eq!(in_view_count, 3, "exactly the window's 3 commits are in_view");
    assert_eq!(hits.iter().filter(|h| !h.in_view).count(), 1);
    assert!(hits.iter().find(|h| !h.in_view).unwrap().id == c1);

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_speed_on_thousand_commits() {
    // Smoke-level speed guard for the 2s acceptance budget (backend part):
    // a full walk over 1000 commits with per-commit lowercase matching
    // should stay far below 500ms even on debug builds in CI-like noise.
    let dir = std::env::temp_dir().join(format!("gtv-search-speed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    for i in 0..1000 {
        commit(&dir, &format!("commit number {}", i), &day(1 + i / 100));
    }
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    let start = std::time::Instant::now();
    let hits = reader.search_commits("commit", 50, &empty).expect("search");
    let elapsed = start.elapsed();
    assert_eq!(hits.len(), 50, "caps at limit");
    assert!(
        elapsed.as_millis() < 500,
        "search took {:?} — over the 500ms smoke budget",
        elapsed
    );

    std::fs::remove_dir_all(&dir).expect("clean up");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test search`
Expected: 编译错误 — `no method named search_commits found`。

- [ ] **Step 3: 实现**

`src-tauri/src/models.rs` 末尾追加：

```rust
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
```

`src-tauri/src/git_reader.rs`：`read_git_data` 方法之前插入：

```rust
    /// Full-history commit search: case-insensitive substring on the commit
    /// subject or author name; a >=4-hex query also matches commit-id
    /// prefixes (inside the same walk, so ambiguous prefixes all surface).
    /// Hits come back newest-first (walk order) and stop at `limit`.
    /// `loaded` is the pagination session's oid set — membership becomes
    /// the `in_view` flag.
    pub fn search_commits(
        &self,
        query: &str,
        limit: usize,
        loaded: &HashSet<String>,
    ) -> Result<Vec<SearchHit>, String> {
        let q = query.trim().to_lowercase();
        if limit == 0 {
            return Ok(Vec::new());
        }
        let is_hex = q.len() >= 4 && q.chars().all(|c| c.is_ascii_hexdigit());

        let seeds = self.collect_lane_seeds()?;
        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;
        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;
        let mut pushed = false;
        for seed in &seeds {
            if let Ok(oid) = Oid::from_str(&seed.tip) {
                revwalk
                    .push(oid)
                    .map_err(|e| format!("Failed to push tip {}: {}", seed.name, e))?;
                pushed = true;
            }
        }
        if !pushed {
            revwalk
                .push_head()
                .map_err(|e| format!("Failed to push HEAD: {}", e))?;
        }

        let mut hits: Vec<SearchHit> = Vec::new();
        for oid_result in revwalk {
            if hits.len() >= limit {
                break;
            }
            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;
            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;
            let summary = commit.summary().unwrap_or("").to_lowercase();
            let author = commit.author().name().unwrap_or("").to_lowercase();
            let id = oid.to_string();
            let text_match =
                (!q.is_empty() && (summary.contains(&q) || author.contains(&q)))
                    || (is_hex && id.starts_with(&q));
            if !text_match {
                continue;
            }
            hits.push(SearchHit {
                id: id.clone(),
                message: commit.summary().unwrap_or("").to_string(),
                author_name: commit.author().name().unwrap_or("Unknown").to_string(),
                timestamp: commit.time().seconds(),
                in_view: loaded.contains(&id),
            });
        }

        log::info!("Search {:?}: {} hits (limit {})", query, hits.len(), limit);
        Ok(hits)
    }
```

（实现语义注记：空 query 时 `text_match` 仅由 `is_hex` 决定，空串非 hex——**空查询返回空**。Step 1 的测试按此语义用 `"c"` 作命中词（fixture 中 4 条 subject 含 c），勿改回空串。）

`src-tauri/src/commands.rs`：`get_commit_stats` 命令之后插入：

```rust
/// Full-history commit search (Cmd+F). Read-only: walks every commit from
/// the branch tips and matches subject/author substrings. `in_view` marks
/// commits inside the current pagination window.
#[tauri::command]
pub async fn search_commits(
    query: String,
    limit: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };
    let loaded: HashSet<String> = {
        let session = state.session.lock().unwrap();
        session
            .as_ref()
            .map(|s| s.seen.clone())
            .unwrap_or_default()
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.search_commits(&query, limit, &loaded)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
```

`src-tauri/src/lib.rs` invoke_handler 列表加一行（`commands::get_recent_logs,` 之后）：

```rust
            commands::search_commits,
```

`src/types.ts` 末尾追加：

```typescript
/** One full-history search hit (Cmd+F); `in_view` flags membership in the
 *  currently loaded window — outside hits jump via jumpToCommit. */
export interface SearchHit {
  id: string;
  message: string;
  author_name: string;
  timestamp: number;
  in_view: boolean;
}
```

`src/api.ts` 末尾追加：

```typescript
export async function searchCommits(query: string, limit: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search_commits', { query, limit });
}
```

（`src/api.ts` 顶部 import 补 `SearchHit` 类型。）

- [ ] **Step 4: 跑测试确认全过**

Run: `cd src-tauri && cargo test --test search`
Expected: 4 passed。再跑 `cargo test --test layout_pure --test pagination`（回归）与 `npm run build && npm test`（TS 镜像编译 + 既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/git_reader.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tests/search.rs src/types.ts src/api.ts
git commit -m "feat: full-history commit search (search_commits backend command)

Case-insensitive subject/author substring match over the whole repo walk
(plus commit-id prefix for hex queries), newest-first, limit-capped,
in_view flagged against the pagination session. TS mirror + api wrapper
land on the same commit (IPC contract).

Backstory: docs/work-backstory/commit-search-m1-3.md
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 后端 `jump_to_commit`（单种子视图 + 命令 + 测试）

**Files:**
- Modify: `src-tauri/src/git_reader.rs`（read_git_data_from_commit）
- Modify: `src-tauri/src/commands.rs`（jump_to_commit 命令）
- Modify: `src-tauri/src/lib.rs`（注册）
- Modify: `src/api.ts`（jumpToCommit 包装）
- Modify: `src-tauri/tests/search.rs`（追加 jump 测试）

**Interfaces:**
- Consumes: Task 1 无依赖；用 `build_view`/`ViewResult`/`stale_seeds`/`store_session`（既有）。
- Produces: Rust `GitReader::read_git_data_from_commit(&mut self, commit_id: &str, limit: usize) -> Result<ViewResult, String>`；命令 `jump_to_commit(commit_id: String) -> Result<GitData, String>`（session 接管、`current_branch = None`、`current_view` 更新）；TS `export async function jumpToCommit(commitId: string): Promise<GitData>`。

- [ ] **Step 1: 追加失败测试（`tests/search.rs` 末尾）**

```rust
#[test]
fn jump_builds_ancestry_window_and_pages_from_it() {
    let dir = std::env::temp_dir().join(format!("gtv-jump-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    for i in 1..=12 {
        commit(&dir, &format!("c{}", i), &day(i));
    }
    let c7 = git_sha(&dir, "HEAD~5");

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    // The default window (newest 4) does not contain c7 — that is exactly
    // the situation a search jump lands in.
    let window = reader.read_git_data(4).expect("window");
    assert!(window.data.commits.iter().all(|c| c.id != c7));

    let jumped = reader
        .read_git_data_from_commit(&c7, 5)
        .expect("jump view");
    // Ancestry window of 5: c7 plus its 4 ancestors (c7 is the newest).
    assert_eq!(jumped.data.commits.len(), 5);
    let newest = jumped
        .data
        .commits
        .iter()
        .max_by_key(|c| c.timestamp)
        .unwrap();
    assert_eq!(newest.id, c7, "the jumped-to commit is the window's newest");
    // The pseudo-seed lane is named by the short hash and owns the target.
    assert_eq!(newest.lane_owner, c7[..7]);

    // Pagination continues from the jumped window: the remaining older
    // history (c1..c2) pages in and the walk terminates.
    let seen: HashSet<String> = jumped.data.commits.iter().map(|c| c.id.clone()).collect();
    let full = reader
        .load_more(&jumped.seeds, &seen, jumped.data.commits.clone(), 5)
        .expect("page after jump");
    assert_eq!(full.commits.len(), 7, "c1..c7 total");
    assert!(!full.has_more);

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn jump_rejects_bad_ids() {
    let dir = std::env::temp_dir().join(format!("gtv-jump-bad-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    commit(&dir, "c1", &day(1));
    // Annotated tag: a real tag OBJECT whose oid is not a commit.
    git(&dir, &["tag", "-a", "-m", "v1", "v1"], &day(1));
    let tag_oid = git_sha(&dir, "v1");
    git(&dir, &["tag", "-d", "v1"], &day(1)); // keep the object, drop the ref noise

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let err = reader.read_git_data_from_commit("deadbeef", 5).unwrap_err();
    assert!(err.to_lowercase().contains("invalid") || err.to_lowercase().contains("not found"));

    let err = reader.read_git_data_from_commit(&tag_oid, 5).unwrap_err();
    assert!(err.to_lowercase().contains("not found"), "tag object is not a commit: {}", err);

    std::fs::remove_dir_all(&dir).expect("clean up");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test search`
Expected: 编译错误 — `read_git_data_from_commit` 不存在（前 4 个测试仍过）。

- [ ] **Step 3: 实现**

`src-tauri/src/git_reader.rs`：`read_git_data_from_branch` 之后插入：

```rust
    /// View "from one commit": a single-seed window over the target's
    /// ancestry (search jumps land here). The seed claims the first lane
    /// under the commit's short hash — there may be no branch ref pointing
    /// anywhere near it. Same shape as read_git_data_from_branch so the
    /// pagination session takes over seamlessly.
    pub fn read_git_data_from_commit(
        &mut self,
        commit_id: &str,
        limit: usize,
    ) -> Result<ViewResult, String> {
        let oid = Oid::from_str(commit_id)
            .map_err(|e| format!("Invalid commit id {}: {}", commit_id, e))?;
        // find_commit rejects non-commit objects (e.g. annotated tags).
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|e| format!("Commit not found: {}", e))?;
        let id = commit.id().to_string();
        let seeds = vec![LaneSeed {
            name: id[..7].to_string(),
            tip: id,
        }];
        let data = self.build_view(&seeds, limit)?;
        let stale_names = Self::stale_seeds(&seeds, &data);
        Ok(ViewResult {
            data,
            seeds,
            stale_names,
        })
    }
```

`src-tauri/src/commands.rs`：`switch_branch` 之后插入：

```rust
/// Jump the view to a single commit's ancestry (Cmd+F hit outside the
/// loaded window). Same session semantics as switch_branch; the view is no
/// longer "from a branch", so current_branch is cleared.
#[tauri::command]
pub async fn jump_to_commit(
    commit_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_commit(&commit_id, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    store_session(&state, &result, true);
    let data = result.data;

    {
        let mut current_branch = state.current_branch.lock().unwrap();
        *current_branch = None;
        let mut current_view = state.current_view.lock().unwrap();
        *current_view = Some(data.clone());
    }

    log::info!("Jumped to commit with {} commits", data.commits.len());

    Ok(data)
}
```

`src-tauri/src/lib.rs` 注册（`commands::search_commits,` 之后）：`commands::jump_to_commit,`

`src/api.ts` 追加：

```typescript
export async function jumpToCommit(commitId: string): Promise<GitData> {
  return invoke<GitData>('jump_to_commit', { commitId });
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `cd src-tauri && cargo test --test search && npm run build`
Expected: 6 passed；tsc 干净。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git_reader.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/api.ts src-tauri/tests/search.rs
git commit -m "feat: jump_to_commit — single-seed ancestry window for search jumps

Out-of-window search hits open a view from the target commit (lane named
by its short hash), session takes over pagination; non-commit oids and
missing ids fail with readable errors.

Backstory: docs/work-backstory/commit-search-m1-3.md
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 前端纯函数 `src/locate.ts`（matchLoaded + mergeLocate，TDD）

**Files:**
- Create: `src/locate.ts`
- Create: `src/locate.test.ts`

**Interfaces:**
- Consumes: `CommitNode`/`BranchLane` from `./types`；Task 1 的 `SearchHit` from `./types`。
- Produces（Task 4 依赖）:
  - `export type LocateResult = { kind: 'branch'; name: string; color: string; commitId: string } | { kind: 'commit'; id: string; message: string; author: string; timestamp: number; in_view: boolean };`
  - `export function matchLoaded(commits: CommitNode[], branches: BranchLane[], query: string): LocateResult[]`
  - `export function mergeLocate(local: LocateResult[], remote: SearchHit[], cap = 12): LocateResult[]`

- [ ] **Step 1: 写失败测试 `src/locate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { matchLoaded, mergeLocate } from './locate';
import type { BranchLane, CommitNode, SearchHit } from './types';

function commit(over: Partial<CommitNode>): CommitNode {
  return {
    id: 'aa00000000000000000000000000000000000000', short_id: 'aa00000',
    message: 'm', author_name: 'a', author_email: 'e', timestamp: 1000,
    parents: [], branch_refs: [], fork_branch_name: null, merge_branch_name: null,
    lane_owner: 'main', is_head: false, is_key: true, additions: 0, deletions: 0,
    x: 0, y: 0, lane: 0, ...over,
  };
}

function lane(name: string, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: 0, color: '#00f', is_tag: false, fork_point: null,
    merged_into: null, is_active: true, ...over,
  };
}

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    id: 'bb00000000000000000000000000000000000000', message: 'm',
    author_name: 'a', timestamp: 1000, in_view: true, ...over,
  };
}

const commits = (): CommitNode[] => [
  commit({ id: 'a1c0f00000000000000000000000000000000000', lane_owner: 'main', x: 10, message: 'Fix Login Bug', author_name: 'Alice', timestamp: 300 }),
  commit({ id: 'd4e5f6000000000000000000000000000000000', lane_owner: 'feat/x', x: 20, message: 'add settings', author_name: 'bob', timestamp: 200, branch_refs: [{ name: 'feat/x', is_remote: false, is_tag: false, color: '#0f0' }] }),
  commit({ id: '99990f0000000000000000000000000000000000', lane_owner: 'main', x: 30, message: 'old thing', author_name: 'Carol', timestamp: 100 }),
];

describe('matchLoaded', () => {
  it('matches branch names by substring (any length, case-insensitive)', () => {
    const out = matchLoaded(commits(), [lane('feat/x'), lane('main')], 'FEAT');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'branch', name: 'feat/x', commitId: 'd4e5f6000000000000000000000000000000000' });
  });

  it('matches subject and author when query >= 2 chars', () => {
    const out = matchLoaded(commits(), [lane('main')], 'login');
    expect(out.filter(r => r.kind === 'commit')).toHaveLength(1);
    const byAuthor = matchLoaded(commits(), [lane('main')], 'carol');
    expect(byAuthor.filter(r => r.kind === 'commit')).toHaveLength(1);
  });

  it('skips message/author matching for 1-char queries (noise control)', () => {
    expect(matchLoaded(commits(), [lane('main')], 'x').filter(r => r.kind === 'commit')).toHaveLength(0);
  });

  it('matches hash prefix >= 4 hex, newest first', () => {
    const out = matchLoaded(commits(), [lane('main')], 'a1c0');
    const cs = out.filter(r => r.kind === 'commit') as Array<{ id: string; in_view: boolean; author: string }>;
    expect(cs).toHaveLength(1);
    expect(cs[0].in_view).toBe(true);
    expect(cs[0].author).toBe('Alice');
  });

  it('empty query returns nothing', () => {
    expect(matchLoaded(commits(), [lane('main')], '')).toHaveLength(0);
    expect(matchLoaded(commits(), [lane('main')], '   ')).toHaveLength(0);
  });
});

describe('mergeLocate', () => {
  it('branch hits first, commit hits newest-first, deduped by id (local wins)', () => {
    const local = matchLoaded(commits(), [lane('feat/x')], 'login');
    const remote: SearchHit[] = [
      hit({ id: 'a1c0f00000000000000000000000000000000000', message: 'Fix Login Bug', timestamp: 300 }), // dup of local
      hit({ id: 'cc00000000000000000000000000000000000000', message: 'older login fix', timestamp: 50, in_view: false }),
    ];
    const out = mergeLocate(local, remote);
    const kinds = out.map(r => r.kind);
    expect(kinds.indexOf('branch')).toBeLessThanOrEqual(0);
    const cs = out.filter(r => r.kind === 'commit') as Array<{ id: string; in_view: boolean }>;
    expect(cs.map(c => c.id)).toEqual(['a1c0f00000000000000000000000000000000000', 'cc00000000000000000000000000000000000000']);
    expect(cs[0].in_view).toBe(true, 'local hit kept with in_view=true');
    expect(cs[1].in_view).toBe(false, 'remote-only hit carries backend flag');
  });

  it('caps the merged list', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      hit({ id: `f${i.toString().padStart(2, '0')}000000000000000000000000000000000000000`, timestamp: i }));
    expect(mergeLocate([], many).length).toBeLessThanOrEqual(12);
  });

  it('empty inputs', () => {
    expect(mergeLocate([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module './locate'`。

- [ ] **Step 3: 实现 `src/locate.ts`**

```typescript
import type { BranchLane, CommitNode, SearchHit } from './types';

// ---------------------------------------------------------------------------
// Cmd+F locate: dual-source pipeline. matchLoaded runs instantly over the
// loaded window (branch/hash/message/author); the debounced backend search
// fills in full-history hits, which mergeLocate dedupes and orders.
// ---------------------------------------------------------------------------

export type LocateResult =
  | { kind: 'branch'; name: string; color: string; commitId: string }
  | { kind: 'commit'; id: string; message: string; author: string; timestamp: number; in_view: boolean };

/** Matches over the loaded view. Branch-name substring (any length, the
 *  long-standing behavior), hash prefix (>= 4 hex), and — new — subject or
 *  author substring (>= 2 chars, matching the backend's noise threshold).
 *  Commit hits are newest-first. */
export function matchLoaded(
  commits: CommitNode[],
  branches: BranchLane[],
  query: string,
): LocateResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const colorOf = new Map(branches.map(b => [b.name, b.color]));
  const refTarget = new Map<string, string>(); // ref name -> commit it points at
  const laneTip = new Map<string, { id: string; x: number }>();
  for (const c of commits) {
    for (const r of c.branch_refs) {
      if (!r.is_tag && !refTarget.has(r.name)) refTarget.set(r.name, c.id);
    }
    const lt = laneTip.get(c.lane_owner);
    if (!lt || c.x > lt.x) laneTip.set(c.lane_owner, { id: c.id, x: c.x });
  }

  const out: LocateResult[] = [];
  const names = new Set([...refTarget.keys(), ...laneTip.keys()]);
  for (const name of names) {
    if (!name.toLowerCase().includes(q)) continue;
    const commitId = refTarget.get(name) ?? laneTip.get(name)!.id;
    out.push({ kind: 'branch', name, color: colorOf.get(name) ?? '#888', commitId });
  }
  out.sort((a, b) => (a.kind === 'branch' && b.kind === 'branch' ? a.name.localeCompare(b.name) : 0));

  const textOk = q.length >= 2;
  const isHex = /^[0-9a-f]{4,}$/.test(q);
  const commitHits: LocateResult[] = [];
  for (const c of commits) {
    const hashHit = isHex && c.id.startsWith(q);
    const textHit = textOk && (c.message.toLowerCase().includes(q) || c.author_name.toLowerCase().includes(q));
    if (!hashHit && !textHit) continue;
    commitHits.push({
      kind: 'commit', id: c.id, message: c.message.split('\n')[0],
      author: c.author_name, timestamp: c.timestamp, in_view: true,
    });
  }
  commitHits.sort((a, b) => (b.kind === 'commit' && a.kind === 'commit' ? b.timestamp - a.timestamp : 0));
  return [...out, ...commitHits];
}

/** Merges local (loaded-window) hits with backend full-history hits.
 *  Dedup is commit-kind only, local wins (local hits carry lane_owner
 *  context for dead-lane auto-expansion); branch and commit hits coexist
 *  (long-standing dropdown shape); commit hits newest-first; capped. */
export function mergeLocate(local: LocateResult[], remote: SearchHit[], cap = 12): LocateResult[] {
  const branchHits = local.filter((r): r is Extract<LocateResult, { kind: 'branch' }> => r.kind === 'branch');
  const localCommits = local.filter(r => r.kind === 'commit');
  const seen = new Set(localCommits.map(r => (r.kind === 'commit' ? r.id : '')));
  const remoteOnly: LocateResult[] = remote
    .filter(h => !seen.has(h.id))
    .map(h => ({
      kind: 'commit' as const, id: h.id, message: h.message.split('\n')[0],
      author: h.author_name, timestamp: h.timestamp, in_view: h.in_view,
    }));
  const commitHits = [...localCommits, ...remoteOnly]
    .filter((r): r is Extract<LocateResult, { kind: 'commit' }> => r.kind === 'commit')
    .sort((a, b) => b.timestamp - a.timestamp);
  return [...branchHits, ...commitHits].slice(0, cap);
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `npm test`
Expected: 全部 PASS（既有 20 + 新 8）。`npm run build` 也过。

- [ ] **Step 5: Commit**

```bash
git add src/locate.ts src/locate.test.ts
git commit -m "feat: locate.ts — dual-source search matching/merging (pure functions)

matchLoaded extracts the in-memory matching (branch substring, hash
prefix, new subject/author substring) from App's memo; mergeLocate
dedupes against debounced backend hits, branch-first, newest-first.

Backstory: docs/work-backstory/commit-search-m1-3.md
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: App 接线（防抖后端搜索 + 跳转分流 + 下拉 UI + i18n）

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/settings.tsx`（i18n 词条）
- Modify: `src/App.css`（.locate-author）

**Interfaces:**
- Consumes: Task 1 `searchCommits`、Task 2 `jumpToCommit`、Task 3 `matchLoaded`/`mergeLocate`/`LocateResult`。
- Produces: 完整用户可见功能。

- [ ] **Step 1: i18n 词条（settings.tsx）**

en 字典改/增（`locatePlaceholder` 替换、`locateScopeHint` 删除、两条新增）：

```typescript
  locatePlaceholder: 'Search commits / branches / hash…',
  locateSearching: 'Searching full history…',
  locateHitsCapped: '50+ matches in full history',
```

zh 对应：

```typescript
  locatePlaceholder: '搜索提交 / 分支 / hash…',
  locateSearching: '正在搜索全部历史…',
  locateHitsCapped: '全历史命中 50+ 条',
```

（`locateScopeHint` 在两个字典中都删除——"仅搜索已加载范围"在本任务后为假。）

- [ ] **Step 2: App.tsx 接线**

import 区：`api.ts` 导入补 `searchCommits, jumpToCommit`；新增：

```typescript
import { matchLoaded, mergeLocate } from './locate';
import type { LocateResult } from './locate';
import type { SearchHit } from './types';
```

删除 App.tsx 里本地的 `type LocateResult = ...` 定义（22-24 行，改用 import）。

state 区（locate 状态旁）：

```typescript
  // Debounced full-history search results merged into the dropdown.
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  const [remotePending, setRemotePending] = useState(false);
```

防抖 effect（Cmd+F keydown effect 之前）：

```typescript
  // Full-history search: debounce the query, ask the backend, drop stale
  // responses (cancelled flag). <2 chars skips the call — the loaded-range
  // matcher still runs instantly in the memo below.
  useEffect(() => {
    const q = locateQuery.trim();
    if (!gitData || q.length < 2) {
      setRemoteHits([]);
      setRemotePending(false);
      return;
    }
    let cancelled = false;
    setRemotePending(true);
    const timer = setTimeout(() => {
      searchCommits(q, 50)
        .then(hits => { if (!cancelled) { setRemoteHits(hits ?? []); setRemotePending(false); } })
        .catch(() => { if (!cancelled) { setRemoteHits([]); setRemotePending(false); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [locateQuery, gitData]);
```

`locateResults` memo 整体替换为：

```typescript
  const locateResults = useMemo(
    (): LocateResult[] =>
      mergeLocate(
        matchLoaded(gitData?.commits ?? [], gitData?.branches ?? [], locateQuery),
        remoteHits,
      ),
    [gitData, locateQuery, remoteHits],
  );
```

`handleLocate` 替换为（异步 + 跳转分流）：

```typescript
  const handleLocate = useCallback(async (r: LocateResult) => {
    const id = r.kind === 'branch' ? r.commitId : r.id;
    setLocateQuery('');
    setLocateOpen(false);
    if (r.kind === 'commit' && !r.in_view) {
      // Hit outside the loaded window: swap the view to the target's
      // ancestry (single-seed window), then focus it like any in-view hit.
      setLoading(true);
      setError(null);
      try {
        const data = await jumpToCommit(id);
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        setExpandedDead(new Set());
        setViewResetKey(k => k + 1);
        focusSeqRef.current += 1;
        setFocusTarget({ id, seq: focusSeqRef.current });
        handleCommitClick(id);
      } catch (err) {
        recordFrontendError(errText(err));
        setError(errText(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    // In-view hit: expand its lane if collapsed (compressed or inactive),
    // then center on it.
    const c = gitData?.commits.find(x => x.id === id);
    if (c && inactive?.dead.has(c.lane_owner)) {
      setExpandedDead(prev => new Set(prev).add(c.lane_owner));
    }
    focusSeqRef.current += 1;
    setFocusTarget({ id, seq: focusSeqRef.current });
    handleCommitClick(id);
  }, [handleCommitClick, gitData, inactive, loadDiffStats]);
```

下拉 commit 行与 footer（locate-dropdown JSX 内）——commit 分支渲染加 author span：

```tsx
                        ) : (
                          <>
                            <span className="locate-hash">{r.id.slice(0, 7)}</span>
                            <span className="locate-msg">{r.message}</span>
                            <span className="locate-author">{r.author}</span>
                          </>
                        )}
```

footer 替换（原 `gitData.has_more && locateScopeHint` 块）：

```tsx
                    {remotePending && (
                      <div className="locate-footer">{t('locateSearching')}</div>
                    )}
                    {!remotePending && remoteHits.length >= 50 && (
                      <div className="locate-footer">{t('locateHitsCapped')}</div>
                    )}
```

- [ ] **Step 3: App.css 追加**

```css
.locate-author {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
```

- [ ] **Step 4: 验证**

Run: `npm run build && npm test`
Expected: 都过。

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/settings.tsx src/App.css
git commit -m "feat: wire full-history search into the locate dropdown

Debounced backend search (200ms, >=2 chars) merges into instant
loaded-range matching; out-of-window hits jump to the target's ancestry
view then focus it; commit rows show the author; scope hint replaced by
searching/50+ footers (the loaded-range-only caveat is gone).

Backstory: docs/work-backstory/commit-search-m1-3.md
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: mock 补命令 + E2E + 验收 + 文档收尾

**Files:**
- Modify: `mock.html`（invoke mock 补两个 case）
- Modify: `docs/roadmap.md`（M1.3 勾掉）
- Modify: `docs/work-backstory/commit-search-m1-3.md`（resolve）
- Modify: `docs/superpowers/specs/2026-08-28-commit-search-design.md`（footer 语义细化落档）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: E2E 证据 + 文档同步 + arc 收束。

- [ ] **Step 1: mock.html 补 case**

先读 `mock.html` 找到 invoke mock 的 switch（`case 'get_recent_logs'` 附近），其后追加（`args` 形参名以文件实际为准）：

```javascript
          case 'search_commits': {
            const q = String(args?.query ?? '').trim().toLowerCase();
            const limit = args?.limit ?? 50;
            if (q.length < 2) return [];
            return DATA.commits
              .filter(c =>
                c.message.toLowerCase().includes(q) ||
                c.author_name.toLowerCase().includes(q) ||
                (/^[0-9a-f]{4,}$/.test(q) && c.id.startsWith(q)))
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, limit)
              .map(c => ({
                id: c.id, message: c.message, author_name: c.author_name,
                timestamp: c.timestamp,
                // The mock DATA is one fully-loaded view; split it at the
                // median x so the LEFT (older) half reads as "outside the
                // loaded window" and the jump path is exercisable.
                in_view: c.x >= (DATA.commits[Math.floor(DATA.commits.length / 2)]?.x ?? 0),
              }));
          }
          case 'jump_to_commit': return DATA;
```

- [ ] **Step 2: E2E（浏览器，执行者用 /browse 或等价工具）**

`npm run dev -- --port 1421`（先 curl 探测端口；用户自己的 1420 不要动；完事关掉）。打开 `http://localhost:1421/mock.html`：

1. Cmd+F 输入任一 subject 子串 → 下拉出现 commit 行（hash + subject + author），分支命中仍在前。
2. 选中一条 `in_view=false`（图左远处）的命中 → loading → 视图重置 → 目标居中、详情面板打开。
3. 输入过程中 footer 先显示"正在搜索全部历史…"，防抖后消失。
4. 无 console 错误。

- [ ] **Step 3: 后端回归 + 门禁**

```bash
cd src-tauri && cargo test --test search --test layout_pure --test pagination
```

Expected: 全过（tour_repo 两失败为已知 fixture 问题）。`npm run build && npm test` 全绿。

- [ ] **Step 4: 文档同步**

- `docs/roadmap.md`：M1.3 行移入「已完成的地基」，注明形态（全史搜索 + 范围外命中 ancestry 跳转 + author 显示）。
- spec §4.4 footer 句更新为：「footer 显示搜索中提示；后端命中数达到 limit（50）时显示「全历史命中 50+ 条」——后端截断在 limit，真实总数不可知」。
- backstory：Process 补实施中的意外/决策，Decisions/Lessons 蒸馏，`status: resolved`，commits 补齐本 arc 全部 SHA。

- [ ] **Step 5: 最终 Commit**

```bash
git add mock.html docs/roadmap.md docs/work-backstory/commit-search-m1-3.md docs/superpowers/specs/2026-08-28-commit-search-design.md
git commit -m "docs: M1.3 search E2E via mock; sync docs; resolve backstory arc

Backstory: docs/work-backstory/commit-search-m1-3.md
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

（用户手动验收项，写入报告：`npm run tauri dev` 打开真实大仓库，Cmd+F 搜老提交的 message，计时键入到定位 < 2s。）

---

## 风险提示（实现者注意）

- **Task 1 测试的空查询陷阱**：`search_commits` 对空 query 返回空（`text_match` 恒 false）——Step 1 的测试代码已按命中词 `"c"` 写好（4 条命中、窗口内外 3+1），照抄即可；若自行调整 fixture，重新数一遍每个断言的命中数。
- **handleLocate 变 async**：`onMouseDown`/`onKeyDown` 调用处不 await，行为不变（fire-and-forget），无需改调用点。
- **`remoteHits` 生命周期**：仓库切换/清空 query 时 effect 的早退分支必须清 state，否则旧仓库的全史命中会混进新下拉（effect 已处理，勿删）。
- **jump 后 `inactive` 重算**：新视图的 lane 多为 pseudo-seed 短 hash 名，保护名单不命中——若目标 ancestry 里全是老分支，图可能整屏收拢成痕迹行。这是语义正确的（都死了），目标自身的 lane 是 tip 必然活跃、必然可见。
