---
arc: embedded-terminal
started: 7524b80
status: resolved
commits: []
---

# 内嵌终端（Ctrl+`）与仓库变更感知

## Intent

Issue 原文三句话：`Ctrl + \`` 在底部快捷打开一个 cwd 为当前仓库 root 的
term；用户不跳出应用就能用 git 命令操作仓库；gtv 要能感知仓库变更。
本质是给只读查看器开一个"用户驱动的逃生舱"——gtv 自己仍然一行改仓的
代码都不写，但用户可以在应用的终端里自己动手，gtv 负责把结果反映到
时间线上。

## Process

- 上下文勘察：前端已有 Cmd/Ctrl+,（设置）与 Cmd/Ctrl+F（搜索）的 window
  keydown 先例；mock.html 用 `default: return null` 兜底未知 invoke，天然
  是 PTY 命令的降级路径。后端 AppState 已有 `current_path`（终端 cwd 与
  watcher 的数据源），Tauri 事件（emit/listen）不需要新 capability。
- 技术选型：
  - PTY = `portable-pty 0.9`（纯 Rust sys 绑定层，无 openssl 类 sysroot
    依赖，交叉编译安全性沿用 git2 default-features-off 的先例注释）；
    前端 `@xterm/xterm 5.5` + `@xterm/addon-fit 0.10`（成熟配对，刻意
    不追 6.0.0 新 release）。
  - 监听 = `notify 8` 裸 crate + 自写 300ms trailing 静默去抖（mpsc +
    recv_timeout 循环）。否决 `notify-debouncer-full`：它多带一层
    backend 配置与依赖，而我们只需要"静默收尾"一种语义，40 行自写更
    可控、可测（见 repo_watch_ext.rs 的 burst 断言）。
  - 监听面 = gitdir + commondir 两个目录递归（refs/objects/packed-refs/
    HEAD/index），不看工作区——工作区改动不改提交图且噪声极大。
    commondir 在 linked worktree 下是相对路径（`../..`），必须先与
    gitdir join 再 canonicalize，主仓 commit 才能被 worktree 侧 watch
    看到（tests/repo_watch_ext.rs 专门回归）。
- 后端：`terminal.rs` 的 PtySession/PtyRegistry + 4 个命令（spawn/write/
  resize/close）；读线程 16KiB 循环 + `drain_utf8`（valid_up_to 取最长
  合法前缀、不完整尾部留缓冲）防多字节字符被 read 边界切碎；wait 线程
  独占 child.wait() 触发 pty-exit；线程内一律不 unwrap（release
  panic=abort）。`repo_watch.rs` 的 WatcherGuard Drop 先 drop watcher
  （断开 sender）再 join 去抖线程，open_repository 换仓时先 take 出旧
  guard、在所有锁外 drop（Drop 会阻塞约一个静默期）。
- 前端：TerminalPanel 组件**常挂载**，收起只是 CSS height 折叠——PTY
  会话与回滚缓冲因此跨收起/展开存活；首次 open 才惰性 boot（new
  Terminal + FitAddon + ptySpawn）；attachCustomKeyEventHandler 对
  Ctrl+` 返回 false 让事件冒泡，App 的 window listener 统一开关（焦点
  在图上或终端内都生效，repeat 被 shouldToggleTerminal 过滤不抖动）；
  ResizeObserver 仅在展开且 offsetWidth>0 时 fit（隐藏容器 fit 会得
  0 尺寸）；主题切换经 cssVar 重设 term.options.theme（xterm 不感知
  CSS 变量）。
- 刷新现场保持：App 的 handleRefreshRepo 复刻 loadOlder 的 in-flight +
  pending 防重入；**不 bump viewResetKey**（Timeline 的 resetKey 比对 +
  锚定机制保证视口不跳，分页路径已验证此模式）；selectedCommit 与
  expandedDead 按新数据存活交集保留；分支过滤仍是真子集时重放
  filterByBranches；错误静默（git gc 中途瞬态失败不惊扰用户）。
- 防自激：watcher 在 open_repository 内部 arming 会产生建流期伪事件，
  刷新又会重挂 watcher 形成"刷新→重挂→伪事件→刷新"环。前端
  refreshTsRef 记录每次 open/refresh 完成时刻，1s 内到达的 repo-changed
  直接忽略，环被切断。

## Decisions

- **只读红线不动**：终端是用户驱动的 shell 逃生舱（issue 决策），gtv
  自身不新增任何改动仓库的命令，git 访问仍全走 git2 只读路径；
  capabilities 保持 `core:default + opener:default + dialog:default`
  三项不变。AGENTS.md Security 段记录了该例外。
- cwd 取 `AppState.current_path` 原样（后端单一事实源），前端 repoPath
  prop 只作为"换仓重开"的触发信号，不作为参数传给后端。
- 登录 shell：非 /bin/sh 的 shell 加 `-l`——GUI 启动的 app 继承最小
  PATH（无 /usr/local/bin），登录 shell 重读 profile 后 git 等命令才
  可解析。TERM=xterm-256color 保住 git 输出的 ANSI 彩色。
- 退出态处理：shell 退出后面板显示"已退出"+ Restart 按钮（term.reset()
  + 重 spawn），而不是自动重启——自动重启会在 shell 配置报错时形成
  刷屏循环。
- App 退出清理：`.build(ctx).run(闭包)` 在 RunEvent::Exit 时
  registry.kill_all()，防孤儿 shell 进程。

## Lessons

- **已知限制（记录在案）**：刷新会重置"已分页加载的更早历史"——
  handleRefreshRepo 走 open_repository 重建 2000 窗口，用户此前
  loadOlder 翻出来的更早提交会收回到默认窗口，需要重新翻页。要保住
  得把 session 续传接进刷新路径，成本与本 arc 的"现场保持"目标不成
  比例，留待后续。
- **watcher 重挂空窗**：换仓/刷新时旧 guard drop 到新 guard arm 之间
  有一个静默期长度（~300ms join + 重建流）的监听空窗；期间的 git 变更
  不会触发刷新。1s 忽略窗刻意覆盖它（宁可少刷一次也不要自激环）。
- **良性触发**：`git status`（index mtime）、`git fetch`（refs/objects
  落盘）、外部编辑器的 git hook 等都会触发刷新——它们幂等且现场保持
  已做到"视口不跳、选中保留"，刷新是安全的默认行为。
- xterm.css 必须显式 import，缺了渲染成乱码 DOM；FitAddon 在
  display:none/0 宽容器上 fit 会得到 0 尺寸并往 PTY 灌 0 列——所以
  ResizeObserver 里加了 offsetWidth>0 门槛。
- mock.html 契约：未知 invoke 返回 null，normalizeSessionId(null)===null
  驱动"终端不可用"占位；listen 在 mock 下不抛错（transformCallback
  被 mock），但 try/catch 兜底仍保留——降级路径必须不依赖后端行为。

## Related

- `docs/work-backstory/large-repo-pagination.md` — Timeline 锚定/防视口
  跳动的机制来源（本 arc 的刷新现场保持直接复用该模式）。
- `src/terminalCore.ts` + `verify_tier1/embedded_terminal.sh` — 快捷键
  与降级契约的纯逻辑测试。
