---
arc: multi-repo-tabs
started: 3fdcc4e
status: in-progress
commits: [55ca115, 58473ff]
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
- Task 1 修复波（评审 Important-1/2 + Nit-1，见 tabs-task-1-review.md）：
  五个 sync 读命令（get_commit_detail/get_file_diff/get_compare_detail/
  get_pair_file_diff/get_branch_list）改为 `session_path` 短锁 + 锁外
  spawn_blocking 短命 reader（照 get_commit_stats_impl 既有主流模式）——多
  tab 后一次大 diff 不再持全局 repos 锁阻塞他仓全部命令；get_branch_list
  连同 view/include_stale/stale 集合一并短锁内 clone，行为等价。至此
  RepoSession.reader 零读方，按简报接口块保留字段本体留给 T2（评审两可，
  勿留解释注释）。open 的去重检查与 insert 隔着秒级 await 的 TOCTOU：insert
  前在同一把锁内复查同 canonical path，竞争败者丢弃刚建快照、按 already_open
  语义返回赢家 id + 现状 view（family 照 dedup 路径回写刷新；败者预领的 id
  号烧掉，序号留缝无害）。新增并发测试：多线程 runtime 上两个 tokio::spawn
  任务并行 open 同一路径，断言注册表恰一条 session、两 repo_id 相同、
  already_open 一真一假——对交错落点不敏感，连跑 8 次稳定。测试 1 跨仓断言
  收紧为 contains("Failed to find commit")，钉住「路由成功、对象库 NotFound」
  的偏差 3 语义。门禁：cargo test 65 过 / 2 败（multi_repo 12；2 败仍 tour_repo
  既有）；npm test 81/81；build 过。
- Task 2（Rust：终端四命令 per-repo + close 联动 kill）：过渡态
  AppState.terminal 全局字段删除，PtySession 落 `RepoSession.terminal`（裸
  Option，无内层 Mutex——repos 锁即其保护，构造点唯一：open insert 处
  terminal: None）。spawn 路由拆出 pub `spawn_terminal_in_repo<S>`：spawner
  闭包注入（`FnOnce(PathBuf, u16, u16) -> Result<PtySession, String> + Send +
  'static`），生产 terminal_spawn_impl 委托时注入 spawn_for_app 闭包（签名
  不动，对 Wry 调用者 byte 等价），测试注入裸 spawn_pty + mpsc 回调——动因：
  terminal_spawn_impl 要 &AppHandle 而集成测试造不出真 Wry handle，注入法让
  全部路由语义（幂等/first-wins/close 竞态/未知 id）可测且 terminal.rs 本体
  零改动。语义注释逐条照搬：快路径短锁（guard 必须在 await 前落下，否则
  future 不 Send）；spawn 完成重锁 get_mut 后 first-wins（同仓竞争 spawn 先到
  者赢，败者随 drop 被 kill）。**spawn 期间仓被 close** 是 per-repo 存储逼出
  的语义精化：旧全局存储会把新 session 照样塞进全局（任何仓复用），现在
  无处可存 → 随 `?` 早退当场 drop（kill）+ 统一 "No repository opened"。
  write/resize 快路径：单次 repos 锁内路由转发（原「repo 校验 + terminal
  锁」两段合一，错误优先级不变：先 No repository opened 后 No terminal
  session）。kill：slot 置 None（drop=kill 注释保留）。close_repository 的
  kill 验证：HashMap::remove 返回值显式绑定到块外 drop——`?;` 丢弃其实也
  当场 drop，但绑定把「kill 发生在 repos 锁释放之后」写死成代码事实；Drop
  只 try_lock child + 关 master fd（不阻塞、无线程 join），reap 与 exit 事件
  在 reader 线程异步完成。测试独立成 tests/terminal_multi.rs（5 例，简报二
  选一取独立文件，multi_repo.rs 保持 git 注册表专注）：两仓 spawn id 异且
  单调 + 各落各 slot；输出隔离（各 printf marker，断言只出现在自己回调流，
  对向 1.5s 静默窗反证）；close(A) → A 子进程 5s 内死（exit 回调收 id）+
  write/resize Err + B 存活 write Ok；同仓二次 spawn 同 id（注入必败 spawner
  反证不再 spawn），kill 后 respawn 新 id；未知 repo_id 四命令 Err。门禁：
  cargo test 70 过 / 2 败（新增 5；2 败仍 tour_repo 既有）；npm test 81/81；
  build 过。
- Task 2 修复波（评审 I-1 MUST-FIX + L-1/L-2，见 tabs-task-2-fix-report.md）：
  简报自任的「单次锁内直接转发」是误读旧两段式现状——pty 写**可以**秒级阻塞
  （子进程不读 stdin、tty 输入队列满、大粘贴挂到子进程读为止），Task 2 落地
  后等于一个 tab 的粘贴能冻住全 app 的 repos 锁。形状修正而非打补丁：
  `RepoSession.terminal` 改 `Option<Arc<Mutex<PtySession>>>`——内层 per-session
  锁复刻旧全局终端锁给单 session 写者的串行化，去掉跨 session 耦合；write/
  resize/kill/spawn 一律「短持 repos 锁 clone/take 句柄 → 放锁 → 内层锁做
  pty IO」，kill 的 taken Arc 与 close 的整个 RepoSession 都在锁外 drop
  （PtySession::Drop 的非阻塞不变量从此只保护调用者，不再护全局注册表，L-2
  连带了结）。释放顺序写成代码事实：write/resize 先绑定结果再返回，
  MutexGuard 语句末落、Arc 函数末落，注册表永远不是「drop 还被锁着的 session
  mutex」的那一方。kill 语义按裁定从静默 Ok 钉成 Err "No terminal session"
  （前端唯一调用点 .catch 吞错，无感）。**macOS 实证发现**：默认 canonical
  tty 在输入队列满时丢弃溢出（8MB 写 0.34s 完成，不阻塞），raw 模式才阻塞
  （约 1KB 后卡死直到子进程死）——wedge 回归测试的 fixture 因此是
  `stty raw -echo; printf rawset; sleep 10`，先等 "rawset" marker 握手再发起
  8MB detached 写，期间断言第二仓 open 2s 内完成（旧形状实跑验证：该测试
  2.42s 有界失败，报错信息即病灶）；防挂三保险：writer 线程不 join、子进程
  sleep 10 硬上界、进程退出关 master fd 兜底。另钉 L-1a（无 session 的
  write/resize/kill 精确错误串，路由检查在前）与 L-1b（延迟 spawner +
  entered 信号造出确定性的 spawn 跨 close 窗口：Err "No repository opened"
  + spawner 产出的 session 被 drop-kill，exit 回调 5s 内到）。门禁：cargo
  test 73 过 / 2 败（新增 3；tour_repo 既有）；npm test 81/81；build 过。
