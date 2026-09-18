# 多仓库标签页（multi-repo-tabs）设计 spec v2

日期：2026-09-18 · 状态：待确认
v2 追加（用户 2026-09-18 裁定）：worktree 识别与二级 tab；拖入去重；激活 tab 自动 fetch 远端。
v1 裁定保留：启动恢复全部 tab；每 tab 独立终端；打开入口 = + 按钮 / Cmd+T / 拖放。

## 1 目标

一个窗口内多 tab 并行多仓库：每 tab 独立视图状态/分页会话/终端/watcher 刷新；**worktree 家族以二级 tab 归组呈现**；任何打开入口**统一去重**；**激活 tab 周期性自动 fetch 远端**使远端分支实时呈现；退出全量恢复。

非目标：多窗口；单 tab 内终端拆分；fetch 深度/凭证配置 UI；后台 tab 的网络刷新（仅本地 fingerprint）；分支被兄弟 worktree 占用的预防性 UI（checkout 失败走错误通道照实呈现）。

## 2 侦察结论（2026-09-18 核实）

- `AppState`（commands.rs:22-36）六 Mutex 全单例；23 命令（lib.rs:36-60）隐式作用于「当前仓」。
- watcher.rs：单线程 1.5s 轮询单仓，`repo-changed` payload 裸 path（models.rs:237）。
- **PTY 层已多会话 capable**：`PtySession.id: u64`（terminal.rs:35）、terminal-output/exit 已带 id（models.rs:243-260）、前端 TerminalPanel 已按 id 过滤（TerminalPanel.tsx:106-110）。
- **fingerprint 已覆盖远端 refs**：`repo.references()` 全迭代含 `refs/remotes/*`（git_reader.rs:176-188）——auto-fetch 后 fingerprint 自然变化触发 repo-changed，**fingerprint 零改动**。
- git2 0.20 `Repository::worktrees()` + `find_worktree(name)` 可枚举家族（主仓 `.git/worktrees/` 记录 linked worktrees；从任一成员打开都能枚举全家族）。
- App.tsx 1419 行 / 37 useState，主体为单仓态。
- `AppState.current_branch` 零调用者（M3 已记录）——本 arc 删。
- localStorage：`gtv_latest_repo` 单值。

## 3 只读边界修订（用户显式授权）

gtv 的写仓库操作从一项变两项：
1. 显式确认的 checkout（M3，SAFE 携带）；
2. **后台自动 fetch**——仅更新 `.git` 内远端跟踪引用与对象（refs/remotes、objects），**绝不触碰工作区、本地分支、HEAD、stash**。

README/AGENTS 措辞在收尾任务同步再放宽。fetch 静默失败（离线/私有仓无凭证不弹窗，log 记录）；凭证用 git2 默认 callback（SSH agent / 匿名 HTTPS），私有 HTTPS 仓可能不刷新——文档如实注明。

## 4 后端设计

### 4.1 RepoSession 注册表

```rust
pub struct RepoSession {
    pub reader: GitReader,
    pub path: String,                  // canonical（realpath 归一）
    pub view: Option<GitData>,
    pub session: Option<ViewSession>,
    pub watch_baseline: Option<(String, String)>,
    pub terminal: Option<PtySession>,
    pub family: Vec<WorktreeMember>,   // 枚举快照（见 4.4）
}
pub struct WorktreeMember { pub name: String, pub path: String, pub is_main: bool }
pub struct AppState {
    pub repos: Mutex<HashMap<u64, RepoSession>>,
    pub next_repo_id: AtomicU64,
    pub active: Mutex<u64>,            // 激活 tab（fetch 目标）
    pub auto_fetch: Mutex<bool>,       // 默认 true，设置开关
}
```

锁策略沿 M3 铁律：短持锁取字段，git 重活在锁外；绝不持 repos 锁做树写/revwalk/fetch。

### 4.2 命令契约（23 命令 + 新增）

| 命令 | 改造 |
|---|---|
| `open_repository(path, include_stale)` | 返回 `OpenedRepo { repo_id, already_open, commondir, family, data }`（commondir = canonical 家族键，前端归组用）；注册 session；**若 canonical path 已有 session → 返回既有 repo_id + `already_open: true` + 该 session 现状 view（绝不重置其 ViewSession）**；同族未开成员照常全新 open（新 repo_id），前端按 commondir 归组为二级 tab |
| `close_repository(repo_id)` | 新增：kill PTY、移除 session |
| `set_active_repository(repo_id)` | 新增：前端切 tab 时调 |
| `set_auto_fetch(bool)` | 新增：设置联动 |
| get_commit_detail / get_file_diff / get_compare_detail / get_pair_file_diff / get_branch_list / switch_branch / filter_by_branches / load_older_commits / get_patch_links / search_commits / jump_to_commit / get_commit_stats / get_worktree_status / checkout_branch | + `repo_id` 首参 |
| terminal_spawn / terminal_write / terminal_resize / terminal_kill | + `repo_id`（session 存 RepoSession；事件仍按 session id 路由） |
| get_current_branch | **删除**（零调用者） |
| get_current_path | 实现时核实调用点后删或改 `get_repo_path(repo_id)` |
| is_valid_git_repo / get_recent_logs | 不动 |

models.rs ↔ types.ts 同 commit 镜像（repo_id 字段、RepoChanged payload、WorktreeMember、OpenedRepo）。

### 4.3 watcher 与 auto-fetch（两条独立线程）

- **watcher（现状扩展）**：1.5s 轮询**全部** repos 的 fingerprint（本地+远端 refs 都在指纹里），变化者 emit `RepoChanged { repo_id, path }`（payload 破坏性变更，models.rs:237 文档同步）。**所有 tab 都刷新**（后台 tab 的本地变更照旧覆盖——用户只把 fetch 限定在激活 tab，本地 fingerprint 不省）。
- **fetch 线程（新）**：60s 周期，仅对 `active` 仓执行 `Remote::fetch`（默认 credential callback）；**busy-skip**（上一轮未返回则跳过本轮，防网络挂死叠加）；`auto_fetch=false` 时休眠空转。fetch 成功 → refs/remotes 变化 → 下一轮 watcher fingerprint 命中 → repo-changed → 前端重建呈现远端分支。fetch 不自己 emit 事件（单一刷新路径铁律延续）。
- worktree 家族共享 commondir refs：激活成员 fetch 后，同族其他成员的 fingerprint 同样变化、各自刷新——预期行为。

### 4.4 worktree 家族枚举

- `open_repository` 时 `repo.worktrees()` 枚举 + 主仓自身，构造 `family` 快照附在 OpenedRepo；成员含 name/path/is_main。linked worktree 路径消失（validate 失败）跳过并 log。
- 家族快照刷新时机：该仓 repo-changed 刷新时顺带重枚举（`git worktree add/remove` 必然改变主仓 .git → fingerprint 动 → 刷新链路自带）。
- **二级 tab 成员是 lazy 的**：family 只是元数据；点二级 tab 才 `open_repository` 该成员（去重规则同 4.5）。

## 5 前端设计

### 5.1 两级 tab 壳

- App 持有：一级 tab 列表（家族代表 = 首次打开的成员，标题 = 家族主目录名）、激活 repoId、空态欢迎面板、拖放监听。
- **二级 tab 行**：tab 栏下一行横向 chips，仅激活家族的 `family.len() > 1` 时显示（单 worktree 仓库零 UI 变化）；成员显示名 = worktree 名；已开成员 chip 高亮，未开成员 chip 点击即 open（lazy）；主仓成员名 = 目录名 + 「主」标记。
- **RepoView.tsx**：承接 App.tsx 主体全部单仓态；props `{ repoId, path, active }`；保活切换（非激活 display:none，切回触发 fit 信号）。
- 恢复：`gtv_tabs = { members: string[] /*扁平成员 path*/, active: string }`；启动串行 open 后按 family 归组建组；旧 `gtv_latest_repo` 迁移后移除。成员 open 失败 → 该成员呈错误态（重选/关闭），不阻塞其他。

### 5.2 统一去重（修订 v1「同仓多 tab 允许」）

**任何打开入口**（+ 按钮、Cmd+T、拖放、二级 tab chip）对同一 canonical path：
- 已开 → 激活该 tab；
- 是某已开家族的未开成员 → 该家族下开二级 tab；
- 判定由后端 open_repository 的 already_open 语义承担（前端不做路径比对——realpath/commondir 归一在后端做才准）。
- v1 的「允许同仓多 tab」条款**废除**：所有入口统一去重（浏览器语义），避免入口间行为分裂。需要「同仓双视图」时用二级 tab（worktree）或未来视图方案替代。

### 5.3 拖放 / i18n / CSS

- 拖放：`getCurrentWebview().onDragDropEvent`，paths[0] 过 is_valid_git_repo → open（后端去重兜底）；无效路径轻提示。
- i18n 新键（en/zh）：newTab、closeTab、welcomeTitle、welcomeOpen、welcomeDropHint、repoOpenFailed、retry、mainWorktree、autoFetch、（fetch 无新可见文案——静默）等；tab 栏/二级行样式走既有 token。

## 6 边界情况

1. 同族两成员各自 watcher 刷新（其一 fetch/checkout）：预期，各自保选择重建。
2. 后台 tab 收 repo-changed：display:none 下照跑（数据正确优先）。
3. checkout 确认框开着切 tab：随 RepoView 隐藏、切回仍在。
4. close 后在途响应：cancelled-flag 兜底。
5. 拖入与已开 tab 同路径但 symlink/别名：后端 realpath 归一去重。
6. 分支被兄弟 worktree checkout：本成员 checkout 该分支 → git 拒绝 → 错误通道呈现（无预防 UI）。
7. fetch 中用户关 tab/切走：busy 线程自然结束、结果丢弃（session 已删则忽略）。
8. 离线启动：fetch 静默失败，本地功能不受影响。
9. 旧 gtv_latest_repo 存在：迁移为单成员恢复。

## 7 测试策略

- Rust（git CLI 造仓）：多仓并发 open 独立 session；repo_id 路由隔离；already_open 去重（同 path、symlink path、同家族 worktree 成员）；close 后 id 失效；watcher payload 带 repo_id；**worktree 家族枚举**（`git worktree add` 造两成员，从主/从两端打开 family 一致）；fingerprint 对 refs/remotes 变化敏感（造 remote ref 移动）；fetch 线程 busy-skip 与 auto_fetch=false 空转（网络 fetch 本身列真机手动项）。
- 前端纯函数：tabs/家族归组状态机、恢复迁移、二级 tab lazy 语义。
- E2E（mock 多仓 + worktree 桩）：tab 开/切/关、保活、两级 tab 呈现与 lazy 打开、去重激活、空态、恢复、终端输出按 id 隔离。拖放与真实 fetch 列真机手动项。
- 门禁基线：cargo 53+2tour / npm 81/81 / build。

## 8 风险

1. display:none 下 D3 零尺寸：切回触发 fit 信号；实现时验证隐藏态无破坏性重排。
2. 内存：每成员全量 commits；家族+多 tab 观察后再议上限。
3. 契约断裂期（后端签名先行、前端接线在后）：期间不跑真机（惯例）。
4. App.tsx 搬移量大：RepoView 抽取独立零行为任务，DiffView 式逐字节比对评审。
5. fetch 网络挂死：busy-skip 防叠加；线程退出随进程。
6. 家族快照陈旧（worktree 在别处被删）：validate 失败跳过 + repo-changed 链路自带重枚举。

## 9 任务切分（8 任务，plan 详化）

1. Rust：RepoSession 注册表 + repo_id 线程化 + open/close + active + watcher 多仓 + RepoChanged payload + **worktree 家族枚举与 already_open 去重** + tests。
2. Rust：终端四命令 per-repo + close 联动 kill + tests。
3. Rust：fetch 线程（busy-skip/auto_fetch/默认凭证/静默失败）+ set_auto_fetch + tests。
4. 前端：App.tsx → RepoView.tsx 零行为搬移。
5. 前端：两级 tab 壳（家族归组/成员行/保活/恢复/快捷键/空态/统一去重）+ api.ts 全量 repoId。
6. 前端：拖放 + per-tab 终端收尾 + autoFetch 设置开关 + i18n + CSS。
7. mock 多仓/worktree 桩 + E2E。
8. opus 终审 + 修复波 + 文档收尾（README/AGENTS 只读措辞二次放宽：checkout + 后台 fetch 两例外；roadmap 多 tab 立项落地）。
