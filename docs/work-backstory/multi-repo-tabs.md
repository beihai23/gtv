---
arc: multi-repo-tabs
started: 3fdcc4e
status: in-progress
commits: [55ca115, 58473ff, 77df2d1, ad8534d, c4ab95a, b979e12, b6325d3]
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
- Task 3（Rust：fetcher 线程 + fetch_remotes + set_auto_fetch）：写仓库第二例外落地。
  fetch_remotes 落 git_reader.rs（git2 全落此文件铁律）：`repo.remotes()` 枚举逐个
  `find_remote` + `fetch(&[], ...)`——空 refspec slice 走 remote 配置的默认 refspec
  （+refs/heads/*:refs/remotes/<name>/*，git clone / git remote add 造的 remote 必有）；
  不 prune；RemoteCallbacks 只装 `Cred::ssh_key_from_agent`（callback 仅在 transport
  索要时触发：匿名 HTTPS 与本地 file:// 永不调它，私有 HTTPS 无凭证 → 失败进列表，
  不弹窗不 panic）；单 remote 失败 push 进 Vec<String> 继续下一个。一个 rustc 现实：
  空 slice 推不出 `AsRef<str>` 元素类型，需 `let refspecs: [&str; 0] = []` 显式标注。
  fetch 后零副作用：不 emit、不碰 fingerprint——watcher 下一轮 fingerprint 命中
  refs/remotes 移动，单一刷新路径铁律。
  fetcher.rs：`spawn(app)` 起 std::thread 60s 循环（骨架照 watcher.rs，panic=abort
  注释复刻）；线程私有一个 current_thread tokio Runtime（tick 的 spawn_blocking 需要
  异步驱动，循环外构建一次终身复用）；`pub async fn fetch_tick(&AppState) ->
  TickOutcome` 可直测（测试不睡 60s）。检查序：auto_fetch 关 → AutoOff（先于一切
  注册表读取）；读 active（自有锁）后**紧邻**短持 repos 锁复查该 id 仍注册（评审
  Nit-5 必写：两 tick 之间 tab 可能已关/切走，未复查的 id 绝不 fetch）并 clone
  canonical path 即放锁——active 与 repos 两锁从不嵌套持有（沿既有代码纪律，复查
  与读 active 「紧邻完成」即满足简报要求）；busy `AtomicBool::swap(true)` 已真 →
  Busy（上一轮网络挂死不叠加）；`spawn_blocking` 短命 `GitReader::new(path)?.
  fetch_remotes()`（绝不持 repos 锁）。busy 标志 = AppState.fetching: AtomicBool
  （fetcher 专有、非 per-session：fetch 目标随 active 走，repo 关闭时无它自己的
  东西要清理）；swap 之后所有路径 store(false)。TickOutcome 五变体：Skip 的语义
  裁定为「tick 已派发但仓打不开（目录被删）或 blocking task 死亡」——简报枚举列了
  Skip 但步骤描述里三处早退都写 Skip，与测试断言的 AutoOff/NoActive/Busy 冲突，
  按 summary 与测试为准，Skip 落在唯一剩下的真实分支上，五变体全部有构造点。
  失败列表 ONE 行 log::info 汇总（离线不刷屏），成功完全静默。set_auto_fetch 按
  impl 模式一行壳；**无立即触发语义**（开关下次 tick 生效，≤60s 延迟，文档注明，
  真机手动项）。
  测试 6 例（multi_repo.rs，file:// bare 上游零网络；**实证确认** libgit2 对
  file:// remote 的 fetch 行为符合假设，fixture 零修正）：fetch 落地 + 写面钉死
  （refs/remotes/origin/main = 上游新 oid，HEAD oid / 本地分支 oid / worktree 文件
  字节三重不变——这三条断言就是写白名单验收）；死 remote 不弃全体（failures 含
  dead 不含 origin，origin 新提交照常落地）；busy-skip（store(true) → Busy 且新
  提交未落地、标志不被误清；清掉 → Fetched 且标志复位）；auto_fetch=false 空转 +
  回开下一 tick 恢复（钉住无立即触发语义）；仅 active 仓（A 动 B 不动）；Nit-5
  （close 后手工把 active 指回已关 id 模拟两 tick 间竞态 → NoActive 不 panic，且
  因 A 目录还在、断言其 refs 确实未动——不复查就真的会写；切 active 到 B 后正常
  fetch）。fixture：seed 工作树 + `clone --bare` 造上游 + `clone file://` 造被测仓，
  上游前进 = seed 里提交再 push（被测仓全程不被碰）。
  门禁：cargo test 79 过 / 2 败（新增 6；2 败仍 tour_repo 既有）；npm test 81/81；
  build 过。真机网络 fetch（SSH agent、私有 HTTPS）列真机手动项，不在测试范围。
- Task 4（前端：App.tsx 主体 -> RepoView.tsx 零行为搬移）：App.tsx 1419 行瘦成
  62 行全局壳（showTags/compressed/showMergeLinks/showRefLabels/fitSignal 全局
  偏好 + showSettings/showIssueReport 可见性 + Cmd+, 监听 + SettingsDialog 渲染
  + 单个 `<RepoView/>`），其余 1357 行主体整体迁入新文件 src/RepoView.tsx。
  **header 归属裁定**：简报验收行「<400 行：header + ...」与自己的状态分类表
  （gitData/branchList/inlineBranches 材料/showAllTags 等全部随主体搬）+「props
  接口保持最小」冲突——现 header 九成内容读 per-tab 态，若留在 App 则 RepoView
  需回传/下传十余个值，分类表即被架空；且 T5 目标形态（spec 5.1）里 App 的
  「header」是新增 tab 栏，非现 header。按分类表执行：**整个 `<header>` 随主体
  进 RepoView**（设置齿轮按钮经 `setShowSettings` 上行 prop 回 App）。
  **byte 等价技巧**：props 命名刻意沿用原标识符（`setCompressed`/
  `toggleShowTags`/`setFitSignal`/`setShowIssueReport`/`setShowSettings`），
  搬移代码里对这些名字的每一处引用零改动；fitSignal 维持 App 持有 + setter
  下传（简报明令 T4 不动其机制，T5 改 per-tab）。
  **IssueReportDialog path 修复选型**：三项上下文（currentError/repoName/
  commitCount）全是 RepoView 态，若对话框留 App 需持续上提三值；按简报备选
  「RepoView 渲染 + path prop」——可见性仍在 App（`showIssueReport`/
  `setShowIssueReport` 下传），对话框 JSX 随主体进 RepoView，新增 `repoPath`
  prop（=latestRepo）替换对已删命令 getCurrentPath 的调用（原 catch 兜底变纯
  prop 推导，无 async）。SettingsDialog 内嵌的 IssueReportDialog 用法不动
  （红线：SettingsDialog 签名）——该路径本就不传 repoName，修复前后可观察结果
  同为 repo=null（修复前是 invoke 被拒后落 null）。
  **明知未修**：handleOpenRepo 里 `await getCurrentPath()`（原 :336）逐字节照搬
  ——真机上 picker 打开路径在 T1 起就断（命令已删，await 抛错跳过分支列表加载
  并落错误横幅），属 T1-T5 契约断裂期既定状态（期间不跑真机 dev），T5 api.ts
  改造时由 OpenedRepo 返回值取代；本任务修它会触碰 api.ts 红线。
  欢迎页随 gitData/latestRepo 落 RepoView（「follow the data」）。DOM 层面唯一
  结构变化：SettingsDialog 从 CheckoutDialog/IssueReportDialog 之前挪到之后
  （三者都是 fixed + 显式 z-index 的浮层，且无可同时打开路径，视觉零差异）。
  逐字节机械核对：以 git show HEAD:src/App.tsx 重建期望 RepoView 体并 diff 实际
  文件，除「原 :1268-1269 两行行尾空白被剥」外零差异；App 侧留守 hunk
  （Cmd+, 效应/showTags 块/视图偏好块/SettingsDialog 渲染）逐行比对 OK。
  门禁：npm test 81/81；npm run build 过（chunk >500kB 警告既有）；cargo 未动。
- Task 4 修复波（b6325d3，评审 Important-1）：搬移把 SettingsDialog 挪到了
  repo body 之后，但它与 Checkout/IssueReport 同用 z-80 backdrop——同 z 下
  paint 序 = DOM 序，旧 App 先渲染 SettingsDialog，「别的 modal 开着时按
  Cmd+,」由「第一击关掉上层 modal」翻转为「settings 盖上去」。可达行为
  翻转（Cmd+, 不被 modal 挡），一行移回 + 注释钉死。
- Task 5（前端：两级 tab 壳 + api.ts 全量 repoId + 统一去重 + 恢复 + 保活）
  ——契约断裂期收口，T1 起断裂的全链路（picker 开仓/stale 切换/终端/刷新）
  自此在真机恢复可用。
  后端唯一增量 set_include_stale（impl 模式 + 一行壳）：短锁先翻
  session.include_stale（竞争中的 get_branch_list 不得用旧策略应答）→
  锁外 spawn_blocking read_git_data(2000) → update_view_session 存回 view+
  分页 session（照 open 的快照模式）；watch_baseline/terminal/family 一概
  不碰。测试的 fixture 难点：open 窗口固定 2000，小仓造不出 stale 分支，
  2100 个 `git commit` 子进程又太慢——改用 **git fast-import 单进程流**
  （2100 条链式 commit + stale 分支从 mark 80 分叉、tip 时间落在 c80/c81
  之间，最新 2000 窗口必然排除它）；注意 fast-import 语法 `from` 在 `data`
  **之后**（放错报 "expected 'data n'"）。+2 例：切换翻转 include_stale +
  分页 seeds 含/不含 stale + get_branch_list 镜像过滤 + 未知 id Err；终端
  跨两次切换同 id 仍可写（spawn_terminal_in_repo 注入 spawner，terminal_
  multi 模式）。
  tabs.ts 纯函数模块（测试先写，16 例）：groupTabsByCommondir 插入序稳定
  归组；nextActiveAfterClose **返回 pre-close 列表的下标**（右侧优先→左侧
  →-1），调用方先解析成 repoId 再 filter（下标跨 filter 会漂移，id 不会）；
  migrateRestore gtv_tabs 优先、legacy gtv_latest_repo 单成员迁移读后删，
  **gtv_tabs 胜出路径也删 legacy**（一旦有 tab 列表它就是唯一权威，迁移
  read-once）；脏 gtv_tabs 落穿到 legacy 而非直接 null；persistTabs 写
  {members:[{path,commondir}], active}（repoId 是运行期 id 不落盘）。
  api.ts 全量改造（本 commit 起唯一契约面）：14 仓命令 + 4 终端命令全部
  repoId 首参；openRepository 返回 OpenedRepo；删 getCurrentPath/
  getCurrentBranch；增 closeRepository/setActiveRepository/setAutoFetch/
  setIncludeStale；selectAndOpenRepository 保留为契约面（返回 OpenedRepo|
  null）但 **App 不用它**——App 自己跑 dialog 再走 openTab(path)， picker
  拿到的 path 要进 TabInfo，而 OpenedRepo 不带 path 字段（后端加字段超本
  任务红线）。types.ts repo-changed 注释清为 RepoChanged{repo_id,path}。
  RepoView 手术：props 终态 {repoId, path, initialData, active,
  onOpenPicker, showTags, toggleShowTags, compressed, setCompressed,
  showMergeLinks, setShowMergeLinks, showRefLabels, setShowRefLabels,
  showIssueReport, setShowIssueReport, setShowSettings}——fitSignal/
  setFitSignal props 拆除（内化：Fit 按钮 + active false→true 各 bump 一次，
  display:none 回来后 D3 重测）。删除内部 open 流：picker（handleOpenRepo）
  迁 App、恢复开仓（handleOpenLatestRepo）删、LATEST_REPO_KEY 四处全删
  （:349 死 getCurrentPath echo 随之消灭）。gitData 初始 = initialData；
  挂载 effect 承接 open 流尾巴（branchList + M2.4 选择恢复 + diff stats）。
  **刷新路径的关键选型**：T1 统一去重后 re-open 拿回的是既有 view（绝不
  重建），repo-changed 刷新与 stale 切换都改走 setIncludeStale(repoId,
  当前策略)——它是唯一「从 HEAD 全量重读且不碰终端/基线」的命令，与旧
  openRepository 刷新语义逐项等价（分页重建本就是 v1 接受的限制）。repo-
  changed 监听按 payload.repo_id === repoId 过滤，各自独立防抖，不依赖
  emit 顺序。四个键盘监听（Ctrl+`/Cmd+F/箭头/Esc）全部 !active 早退。
  IssueReportDialog 仅 active 时渲染（T4 review Low-3：N 保活 tab 不叠 N
  层 z-80；错误横幅保留各自渲染——随 display:none 隐藏，选型记报告）。
  TerminalPanel/CommitDetails/CompareDetails 均加 repoId prop 透传。
  App 状态机：tabs + activeRepoId（下标纯派生——id 跨 close 稳定而下标
  漂移）+ families + openData（开仓 view，RepoView 首挂读取一次）；
  applyTabs 单写者（refs 同步 + lastActiveInGroup 记录 + persistTabs 派生
  active 下标）。openTab(path) 是唯一 path 入口（picker/恢复/二级 lazy/
  T6 拖放），dedup 判定全靠后端 already_open；closeTab 先 closeRepository
  （后端杀终端）再用邻位规则，families/openData 条目随 tab 清除；
  Cmd+T/Cmd+W 均 preventDefault（**macOS Cmd+W 默认关整个窗口**，tab 壳
  接管）；恢复 = migrateRestore → 依序 openTab → 记录 idx 夹取到末位。
  family 刷新选型（简报裁定）：App 也 listen repo-changed，对命中仓 500ms
  防抖后重调 openRepository(path)——already_open 语义返回新枚举的 family
  快照 + 既有 view（丢弃），一次枚举代价可接受；open 会把 active 指到被
  刷新仓，**随后显式恢复用户实际所在 tab 的 active**（fetch 目标不能被
  后台仓劫走）；防 mid-flight close：返回全新 id 且无 tab 认领时回滚
  closeRepository（防泄漏无主 session）。二级 worktree 行：激活家族
  family>1 才渲染，已开成员高亮（**按 path 直接等值匹配** family 成员的
  canonical path——经 symlink 打开的 tab path 可能对不上，后果仅是该 chip
  暂不显「已开」，后端 dedup 保证不会开出重复 tab）；一级 tab 标题 = 家族
  主目录名，组点击回到该组最后活跃成员。空 tab 欢迎态上提 App（RepoView
  的 null-data 分支留作防御加载/错误态）。
  CSS 只加 tab 布局最小类（.tabbar/.tab/.tab-label/.tab-close/.tab-new/
  .worktree-row/.wt-chip/.tab-body/.tab-body-hidden），token 化，美化留 T6；
  用户可见新文案仅裸 ×/+/• 与路径名（T6 落 i18n：newTab/closeTab/
  mainWorktree/repoOpenFailed 等，spec 5.3 清单）；开仓失败呈 App 级
  error 条（后端原文），下次成功开仓自清。
  TDZ 走查（M1.3）：App 全链 useSettings→状态→refs→applyTabs→
  integrateOpened→openTab→openPicker/closeTab/activateTab→activateGroup/
  closeGroup→refreshFamily→两个监听 effect→恢复 effect→派生态→JSX，每步
  引用先于使用；RepoView fitSignal 声明于首个使用者（激活 effect）之前，
  mount effect 位于 loadDiffStats/handleFilterChange 之后（沿原 open 流
  位置的铁律），四个键盘 effect 依赖数组补 active/repoId，无晚声明引用。
  门禁：cargo test 81 过 / 2 败（multi_repo 18→20；2 败仍 tour_repo 既有
  gitlink）；npm test 97 过（81 既有 + tabs.test.ts 16 新增）；npm run
  build 过（chunk >500kB 警告既有）。mock.html 未碰（T7 桩）。
- Task 5 修复波（评审 CHANGES_REQUESTED：1 Critical + 1 Important + 3c 建议；
  orchestrator 复核追加 I2）：**虚假声明更正（必记）**——原 T5 报告第三节
  「macOS Cmd+W……tab 壳显式接管」为虚假声明：JS 层 preventDefault 在 macOS
  上根本不执行（NSMenu 键等效先于响应链到达 WKWebView，页面 keydown 不发
  生），⌘W 实走 performClose: 关掉整个单窗应用；本波以菜单重建修复，非
  「加固既有接管」。事实链（vendored 源亲核）：tauri 2.10.3 menu/menu.rs
  :171/:217 默认菜单 Window/File 两个子菜单各含一个 close_window 预置项；
  muda 0.17.1 items/predefined.rs:336-338 macOS 上其默认加速键 =
  CMD_OR_CTRL+KeyW（非 macOS 是 Alt+F4，Windows/Linux 不受影响，JS 路径
  已够）。Fix-1（Critical）：lib.rs setup 内 `#[cfg(target_os = "macos")]`
  自建菜单替换默认（App 子菜单 about/services/hide/hide_others/show_all/
  quit 依默认构成复刻，**不含任何 close_window 预置项**；File 放自定义
  MenuItem id="gtv-close-tab" 文本 "Close Tab" 加速键 CmdOrCtrl+W；Edit
  子菜单 undo/redo/cut/copy/paste/select_all 必须保留——无 Edit 项则
  webview 内 ⌘C/⌘V/⌘Z 全失效；View fullscreen；Window minimize/maximize），
  `app.set_menu(menu)?` + `on_menu_event` 命中即对主窗口 emit
  "close-active-tab"（label="main"：tauri.conf.json 无 label 字段，落
  tauri-utils default_window_label 默认值）；App.tsx 新增对应 listen
  effect（try-catch 浏览器 mock 模式），keydown ⌘W 保留为 Windows/Linux
  与兜底路径——菜单吃掉键后 macOS 上 keydown 不可达，两者不会双发。
  Fix-2（I1+I2 合并）：tabs.ts 新增纯函数 nextActiveRepoId(tabs,
  activeRepoId, closedRepoId)（关后台 tab 保当前激活、关激活 tab 走右后左
  邻位、清空归 null；先写测试后实现）；closeTab 改用之且 nextRepoId 非空
  时补 setActiveRepository（后端 active 是 fetch 目标，close_repository 会
  把它归零致 auto-fetch 停摆到下次手点；与 closeRepository 并发乱序两序都
  收敛）；恢复 effect 的 applyTabs 后同样补 setActiveRepository（恢复循环
  的最后一次 open 把后端 active 指到最后打开的仓，与 UI 记录的激活 tab 脱
  钩）。Fix-3（3c 采纳）：refresh_repository 正名——repo-changed 刷新是
  全应用最热读路径，永久骑在 stale 开关名上会被 T7 mock 冻结成契约；
  commands.rs 加 refresh_repository_impl（短锁读 session 当前 include_stale
  → 委托 set_include_stale_impl 同值重建）+ 一行命令壳，lib.rs 注册，
  api.ts 加 refreshRepository(repoId)，RepoView 的 handleRepoRefresh 改调
  之（setIncludeStale 回归只服务设置开关，其 deps 数组随之去掉
  showStaleBranches）。零新仓库写路径（菜单是应用级 chrome）；未动
  watcher/fetcher/mock.html/CSS/i18n（T6）。门禁：cargo test 82 过 / 2 败
  （multi_repo 20→21；2 败仍 tour_repo 既有 gitlink）；npm test 101 过
  （97 既有 + tabs.test.ts 4 新增）；npm run build 过（chunk >500kB 警告
  既有）。真机手动验证项（报告列明，待 orchestrator 汇总）：⌘W 仅关激活
  tab 窗口存活、零 tab 时 ⌘W 无操作、后台组 × 保持当前视图、⌘C/⌘V/⌘Z
  在输入框可用、⌘Q 退出、菜单栏 File 显示 "Close Tab ⌘W"。
- Task 6（纯前端：拖放开仓 + autoFetch 设置 + i18n + tab 样式 token 化 +
  死项清理；零 Rust 改动红线遵守）：**拖放 API 前置核实**——
  tauri.conf.json 全文无 `dragDropEnabled` 键，落 Tauri 2 默认 true：webview
  拦截 HTML5 拖放事件、原生拖放只走 `getCurrentWebview().onDragDropEvent`
  （@tauri-apps/api 2.10.1 webview.d.ts :413，DragDropEvent 为
  enter/over/leave/drop 判别联合，仅 enter/drop 带 paths）。App 监听 effect：
  enter/over 置 dragOver 态、leave/drop 清除、drop 的 paths **依序**
  `await openTab(path)`——openTab 漏斗已统一 dedup+错误条，拖入普通文件
  自然落 repoOpenFailed 条不崩；cleanup 照既有 try-catch 浏览器 mock 模式
  （浏览器里 `getCurrentWebview()` 因 `window.__TAURI_INTERNALS__` 缺失同步
  抛、Tauri 环境 promise reject，try/catch + .catch 双兜，T7 补 stub）。
  视觉：`.drag-overlay`（fixed inset 0、z-200、rgba(var(--bg-canvas-rgb),
  0.55)+blur(4px)、**pointer-events:none**——原生 drop 必须到达 webview 而
  非该层）+ `.drag-overlay-frame`（inset 12px、2px dashed var(--accent)）+
  居中 `.drag-overlay-msg` 显 dropToOpen；空态 welcome 按钮下补
  welcomeDropHint 行（复用 .hint）。
  **autoFetch 设置（spec §4.3）**：`AUTOFETCH_KEY='gtv_autofetch'`，默认
  `!== '0'` 开、'1'/'0' 持久化（照 STALE_KEY 模式）。**默认开的依据**：用户
  需求原文「当前激活的tab要实时刷新……(自动fetch)」是主打功能，默认关等于
  藏起主打卖点；且 fetch 只写 .git 内 refs/remotes 与 objects（写面白名单
  第二项）、静默失败不打扰。App 加 effect
  `void setAutoFetch(autoFetch).catch(()=>{})`（api.ts 既有命令）——后端
  每次启动都是 false，此 effect 同时负责启动同步与切换同步（≤60s 后下一
  tick 生效，T3 语义）；catch 静默（浏览器 mock 无后端，避免污染 issue 环
  形缓冲）。SettingsDialog 镜像 showStale :61-70 的 toggle 节。
  **L5 裁定（记录）**：⌘W/× 关有运行中终端的 tab **不加确认**（浏览器
  tab 语义）；T8 用户手册注明「终端随 tab 关闭而终止」。
  **i18n**（en+zh 成对）：新增 autoFetch/autoFetchTip/repoOpenFailed/
  retry/dropToOpen/welcomeDropHint/closeTab/closeTabGroup/mainWorktree；
  错误条改为 `t('repoOpenFailed') + ': ' + 原始后端消息`（原始错误不翻译，
  是错误契约本身）+ retry 按钮（App 记 openErrorPath，重试重走
  openTab(openErrorPath)，成功开仓自清；按钮复用 .error-report-btn 类，
  与 RepoView 错误条同款，零新 CSS）；一级 × 的 aria-label=closeTab、
  title=closeTabGroup（组语义），路径提示仍在 tab-label 的 title 上；主
  worktree chip 的 title=`mainWorktree\n路径`（解释 • 标记且保留路径悬停，
  换行 title 沿 edgeTip 先例），• 前缀保留为语言中立视觉标记；**删除死键
  openLatest**（en/zh 双侧，latest-repo 按钮已随 T5 恢复机制退役）；welcome
  三键未动。
  **CSS（token only，5 主题零裸色值）**：tab 激活态 = --bg-panel 提升 +
  `box-shadow: inset 0 -2px 0 var(--accent)` 下边（边框常驻 transparent 预
  留几何，激活切换零位移）；hover = --bg-input（沿 close-btn 惯例）；
  tab-close 固定 20px 命中区 + 圆角 hover 底；tab-new 补 hover；tabbar
  `overflow-x:auto`（多 tab 单行滚动，+ 永远可见）；worktree-row 加
  flex-wrap；wt-chip open = text-faint 边 + 亮字、current = accent 边 +
  `rgba(var(--link-rgb),0.25)`（全局活跃色，沿 .view-btn.active/.head-lane）
  + 600 字重；.hint 补 max-width+居中（welcome 双行提示可读换行）；
  **删除死块 .latest-repo-btn** 三规则。
  **终端收尾 verify-only：verified, no gap**——TerminalPanel :186 的
  ResizeObserver deps=[open]（面板 open 跨 tab 切换保持 true——RepoView
  keep-alive，隐藏期观察器不断开）；隐藏 = display:none → RO 触发、
  :187 clientWidth===0 早退；激活 = none→flex → RO 触发真实尺寸 → rAF →
  fit() → onResize → terminalResize 同步 PTY。fitSignal 机制只服务
  Timeline D3 画布（display:none 下 canvas 零尺寸重测），终端自成闭环，
  两机制互不缺位。
  门禁：npm test **101/101**（未提取新纯函数，不加测）；`npm run build`
  （tsc && vite）绿（chunk >500kB 警告既有）；cargo test 82 过 + 2 败
  （仍是 tour_repo 既有 gitlink NotFound，无漂移）。mock.html 未碰（T7）。
