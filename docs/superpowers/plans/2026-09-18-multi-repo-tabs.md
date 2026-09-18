# 多仓库标签页 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一窗口多 tab 多仓库：RepoSession 注册表（repo_id 线程化全部命令）、worktree 家族二级 tab、全入口统一去重、激活 tab 60s 自动 fetch、每 tab 独立终端、退出全量恢复。spec v2 全量落地。

**Architecture:** 后端 `AppState` 单仓六 Mutex → `HashMap<u64, RepoSession>` + `active` + `auto_fetch`；watcher 多仓轮询 + RepoChanged{repo_id,path}；fetcher 独立线程（busy-skip）。前端 App.tsx 瘦成两级 tab 壳，1419 行主体搬 RepoView.tsx（每 tab 一份、display:none 保活）。api.ts 全量 repoId 首参。

**Spec:** `docs/superpowers/specs/2026-09-18-multi-repo-tabs.md`（冲突以 spec 为准）。

## Global Constraints

- **写仓库白名单仅两项**：显式确认的 checkout（M3 既有）+ 后台 fetch（仅 refs/remotes 与 objects，绝不碰工作区/本地分支/HEAD/stash）。其余一切只读。
- git2 访问全部落 `src-tauri/src/git_reader.rs`（含 fetch 与 worktree 枚举）；commands.rs 只做 State/锁/spawn_blocking 薄包装；**命令逻辑放 `*_impl(&AppState, ...)` 普通函数**（AppState 可脱离 tauri runtime 构造直测），`#[tauri::command]` 壳一层。锁铁律：短持 repos 锁取字段，重活在锁外。
- models.rs ↔ src/types.ts 同 commit 镜像。**T1-T3 只动 Rust + types.ts 纯增量**（api.ts 旧签名保留，npm build 不破）；api.ts 全量 repoId 改造在 T5。期间不跑真机 dev（契约断裂期，spec §8-3）。
- 门禁（每任务）：`cd src-tauri && cargo test` 全绿（基线 53 pass / 2 fail = tour_repo 既有 gitlink，非回归）+ `npm test` 81/81 + `npm run build` 过。
- App.tsx TDZ 地雷（M1.3）：新 memo/handler 声明先于使用。
- i18n en/zh 双侧同步；插值走 `t(key, vars)`。
- E2E：mock.html，dev server **1421**（先探测；用户 1420 绝不碰）；gstack browse CLI `$HOME/.claude/skills/gstack/browse/dist/browse`；`fill` 不是 `type`。
- commit trailer：`Backstory: docs/work-backstory/multi-repo-tabs.md` 紧贴 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（无空行，最后）。backstory Task 1 建档（frontmatter：arc/started/status/commits:[]，sha 由后续 docs commit 回填）。
- 断言计数落笔前重数；E2E 期望值回查 fixture 真态（M2/M3 双教训）。

---

### Task 1: Rust — RepoSession 注册表 + repo_id 线程化 + worktree 枚举 + 去重 + watcher 多仓

**Files:** git_reader.rs（`worktree_family()`、`commondir()`、canonical 归一）、commands.rs（AppState 重构 + 全部命令 impl 化 + repo_id 首参 + open/close/set_active）、watcher.rs（多仓轮询 + RepoChanged）、models.rs + types.ts（增量：WorktreeMember/OpenedRepo/RepoChanged）、lib.rs（注册新命令、删 get_current_branch）、Create tests/multi_repo.rs、Create docs/work-backstory/multi-repo-tabs.md。

**要点：** OpenedRepo = `{repo_id, already_open, commondir, family, data}`；already_open 语义 = canonical path 已有 session → 复用 repo_id、返回现状 view、**绝不重置 ViewSession**；同族成员全新 repo_id。`set_auto_fetch` 本任务只加 state 字段（命令 T3 落）。watcher 轮询逻辑抽纯函数可测（fingerprint 全家 → diff → 事件列表）。

**测试（multi_repo.rs，git CLI 造仓 + `git worktree add`）：** 两仓并发独立 session 与路由隔离；filter/load_more 只动自己；close 后 id 失效他 id 正常；already_open 同 path 复用 id 且分页状态保留；symlink 去重；worktree 家族主/从两端打开一致（含 is_main）；同族成员独立 repo_id；fingerprint 对 refs/remotes 移动敏感；watcher diff 纯函数。

**验收：** cargo 全绿（新增 10+ 例）；npm 81/81 + build（types.ts 增量不破）。

### Task 2: Rust — 终端四命令 per-repo + close 联动 kill

**Files:** commands.rs（terminal_* + repo_id）、models.rs/types.ts 若需、tests/multi_repo.rs 增例（或 terminal_multi.rs）。

**测试：** 两仓各 spawn 一会话 id 不同输出不串（terminal_pty.rs 模式）；close_repository 后 PTY 进程消失（drop-kill 已有，钉命令层联动）；kill 后 exit 事件路由正确。

### Task 3: Rust — fetcher 线程 + set_auto_fetch

**Files:** Create src-tauri/src/fetcher.rs（60s 循环、busy-skip AtomicBool、auto_fetch 检查、静默 log）、git_reader.rs（`fetch_remotes()`：Remotes 逐个 fetch，git2 默认 callbacks，单 remote 失败继续）、commands.rs（set_auto_fetch 命令）、lib.rs（spawn fetcher 线程）、tests/multi_repo.rs 增例。

**测试：** **本地 file:// bare 仓做 remote**（无网络可跑）：clone 仓 fetch_remotes 后 refs/remotes 出现上游新提交；busy-skip 纯逻辑；auto_fetch=false 空转不 fetch。

**验收：** cargo 全绿；真机网络 fetch 列手动项。

### Task 4: 前端 — App.tsx 主体 → RepoView.tsx 零行为搬移

**Files:** Create src/RepoView.tsx；Modify src/App.tsx（瘦壳：渲染单个 RepoView + 全局态）。

**要点：** 状态分类清单（brief 给全）：**per-tab 数据态**（gitData/selectedCommit/comparePair/selectedBranches/dateRange/locate 态/hiddenIds/expandedLanes/checkoutDialog/switchedBranch/error…）随主体搬 RepoView；**全局显示偏好**（showTags/compressed/showMergeLinks/showRefLabels…）留 App 下传 props。单 tab 行为零变化；E2E 回归留 T7。DiffView 式逐字节比对评审。

**验收：** npm 81/81 + build；mock 手动冒烟（可选）。

### Task 5: 前端 — 两级 tab 壳 + api.ts 全量 repoId

**Files:** Modify src/App.tsx（tabs 状态机/openTab 去重/closeTab/activate+set_active_repository/恢复 gtv_tabs+迁移/Cmd+T+W/空态/错误 tab 态/二级 tab 行按 commondir 归组/保活 display:none+切回 fit）、src/api.ts（全量 repoId 首参 + 删 getCurrentBranch wrapper + 新增 closeRepository/setActiveRepository/setAutoFetch）、src/tabs.ts + tabs.test.ts（纯函数：归组/恢复迁移/去重决策）。

**要点：** RepoView 常渲染非激活 display:none；active prop 切换触发 fit 信号；每 RepoView 自己 listen repo-changed 按 repo_id 过滤；gtv_tabs={members, active} 迁移 gtv_latest_repo 后删除。

**验收：** npm test（81+新增）+ build；TDZ 走查。

### Task 6: 前端 — 拖放 + 终端多会话收尾 + autoFetch 设置 + i18n + CSS

**Files:** Modify src/App.tsx（onDragDropEvent → is_valid_git_repo → openTab，无效轻提示）、src/components/SettingsDialog.tsx + settings.tsx（autoFetch 开关 localStorage gtv_autofetch 默认 on，联动 set_auto_fetch）、i18n 新键、App.css（tab 栏/二级行/空态/拖放 hover，token）。

**要点：** 终端收尾 = 两 tab 并发会话切换不串流、关 tab kill 验证；conf 的 dragDropEnabled 实现时查证。

**验收：** npm test + build。

### Task 7: mock 多仓/worktree 桩 + E2E

**Files:** Modify mock.html（多仓注册表 MOCK.repos、repo-changed 桩、worktree family 桩、already_open 桩、set_active 桩）。

**E2E：** tab 开/切/关；保活（切回选择+视口不丢）；两级 tab 呈现（family>1）与 lazy 打开；去重（重复拖/开同仓 → 激活不开新）；恢复（reload 后 tab 全回）；终端两 tab 输出隔离；空态。拖放与真 fetch 列真机手动项。js 断言与返回值进报告。

**验收：** 单 commit；npm build 过。

### Task 8: 终审 + 修复波 + 文档收尾

- opus 终审：写白名单边界（checkout+fetch 仅此两项）、单一刷新路径（fetch 不 emit，靠 fingerprint）、既有命令行为零回归（签名变化但语义不变）、RepoView 搬移零行为、内存/事件风暴实测复核。
- sonnet 修复波清零；门禁 + E2E 复跑。
- 文档：README/AGENTS 只读措辞二次放宽（两例外）；AGENTS 测试计数更新；roadmap 多 tab 立项落地；backstory resolved + Lessons；用户手动清单（真 fetch、拖放、worktree checkout 冲突、离线启动）。
