---
arc: multi-repo-tabs
started: 3fdcc4e
status: in-progress
commits: []
---

# 多仓库标签页（multi-repo-tabs）

## Intent

一窗口多 tab 并行多仓库：每 tab 独立视图状态/分页会话/终端/watcher 刷新；
worktree 家族以二级 tab 归组（commondir 为家族键）；任何打开入口（+ 按钮、
Cmd+T、拖放、二级 chip）统一按 canonical path 去重；激活 tab 60s 自动 fetch
远端（写仓库第二例外，仅动 refs/remotes 与 objects）；退出全量恢复。设计：
`docs/superpowers/specs/2026-09-18-multi-repo-tabs.md`（v2），8 任务切分见
`docs/superpowers/plans/2026-09-18-multi-repo-tabs.md`。

## Process

- Task 1（Rust：RepoSession 注册表 + repo_id 线程化 + worktree 家族 + 去重 +
  watcher 多仓）：AppState 由「六 Mutex 单例」改为 `repos:
  Mutex<HashMap<u64, RepoSession>>` + `next_repo_id: AtomicU64` + `active` +
  `auto_fetch`（默认 true，T3 消费）；RepoSession 内聚旧六字段（view/session/
  include_stale/watch_baseline——path 提到外层，基线只存 fp 串）。命令全部
  impl 化：逻辑在 `*_impl(&AppState, repo_id, ...)` 普通函数（async 的照旧
  内嵌 spawn_blocking），`#[tauri::command]` 壳一行委托，tests/multi_repo.rs
  直接构造 AppState 用一次性 tokio Runtime 驱动——为此 lib.rs 把
  commands/watcher 两个模块升 pub（偏离简报未提的可测性前提，报告有记）。
- already_open 语义（spec §4.2 核心）：先 canonicalize（spawn_blocking 内
  `GitReader::canonical_path`，workdir 缺省回落 gitdir），持锁遍历比对
  session.path——命中则返回既有 repo_id + 既有 view 的 clone +
  `already_open: true`，**绝不触碰** ViewSession/include_stale/watch_baseline
  （测试在 session 上 planted 标记钉死）；family 在锁外重枚举后短锁回写，
  回写前检查「id 仍在注册表」防 close 竞态；随后 active 置该 id。view None
  理论不发生，防御路径重读数据但只返回、不落 session（不触碰不变量最大化
  简单）。全新 open 沿旧注释语义：view + fingerprint + family 同一
  spawn_blocking 快照产出（防 poll 与 open 竞态报假变化），成功后才持锁
  insert——错误路径天然不动注册表。
- worktree_family 的关键点：主仓成员从 **commondir 的 parent** 推导而非
  workdir——从 linked worktree 端打开也必须把主仓报成家族头；canonical 父
  路径必 canonical，两端（主/从）枚举出同集合（测试钉死 name/path/is_main
  三元组相等 + commondir 相等）。linked 成员走 `worktrees()` 名字枚举 +
  `find_worktree` + `validate()`：validate 失败或路径 canonicalize 失败的
  成员 log::warn 后跳过（别处删除的 worktree 不能拖垮整个 open）。排序
  main 优先 + 名字序，呈现稳定。成员名照 git 惯例：主仓 = 主目录名，
  linked = 注册名（目录 basename）。
- watcher 多仓：轮询逻辑切出纯函数 `diff_fingerprints(prev, next) -> Vec<u64>`
  ——只报「两图都在且 fp 不同」的 id：首见（只在 next）与消失（只在 prev）
  都不进结果，首见仅记基线不 emit 的语义由函数形状直接保证。poll_loop 短持
  repos 锁快照 (id, path, baseline)，锁外逐仓短命 reader 算 fingerprint（沿
  旧「不碰 session reader」注释语义），回写用 **compare-and-set**：仅当
  session.watch_baseline 仍等于快照值才写新值并 emit——防止 poll 两阶段间隙
  里 open_repository 重置的基线被陈旧快照复活成假变化。仓消失随 session
  删除自然出清。panic=abort 约束注释原样保留。
- terminal 四命令占位路由的选择：保留 AppState.terminal 全局字段（简报
  AppState 草图无此字段，属过渡保留），terminal_* 全部 + repo_id 首参但只做
  「repos 里该 id 存在」校验（不存在 → "No repository opened"），会话本体
  仍是全局单例——对单仓调用者行为 byte 等价（优于 Err 占位方案，且 T2 搬
  RepoSession 时只需换存储位置）。close_repository 的 PTY kill 联动同属 T2。
  close 若关的是 active 仓，active 归 0（none）——fetch 目标悬空比指向已删
  session 诚实，前端切 tab 时会显式 set_active。
- 删除 get_current_path / get_current_branch（后者 M3 起零调用者；前者调用方
  本就持有 path）。lib.rs 注册 close_repository/set_active_repository。
  14 个既有仓命令 + repo_id 后语义零变化：五个 sync 读命令
  （get_commit_detail/get_file_diff/get_compare_detail/get_pair_file_diff/
  get_branch_list）沿用旧形状「锁内用存量 reader 委托」（旧代码本就持
  current_repo 锁做这些纯读），其余命令严格短持锁克隆 path/view/session 后
  锁外 spawn_blocking。
- 测试（tests/multi_repo.rs，11 例，git CLI 造仓照 pagination.rs 模式）：
  两仓并发独立 id 与路由（跨仓查提交是 git NotFound 而非路由错误——简报
  预期文案不成立，按实际语义断言 is_err + 注释说明）；filter/jump 路由隔离
  （A 过滤后 B jump，双方 load_older 各回各自视图）；close 只废该 id；
  already_open 复用 id + filtered view + 三标记保全；symlink 去重；worktree
  家族两端一致（2 成员、is_main、commondir=canonical <main>/.git）；同族
  独立 session；fingerprint 对 refs/remotes/origin/x 移动敏感（T3 fetch 链路
  前提）；diff_fingerprints 三态（不变/变化/首见/消失）；set_active 更新 +
  未知 id Err + close active 归 0；open 失败注册表不动。
- 门禁：cargo test 64 过 / 2 败（新增 11；2 败仍为 tour_repo contentless
  gitlink 既有状态，与基线 53+2 相比零回归）；npm test 81/81；npm run build
  过（chunk >500kB 警告既有）。types.ts 纯增量（WorktreeMember/OpenedRepo/
  RepoChanged）；types.ts 里 repo-changed "plain string path" 旧注释因纯增量
  红线未同步改写，留 T5 清；mock.html 未碰。
