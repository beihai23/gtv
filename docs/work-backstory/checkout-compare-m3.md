---
arc: checkout-compare-m3
started: 294b613
status: in-progress
commits: []
---

# M3 checkout 与对比（真实 checkout + 分支/提交对比）

## Intent

Roadmap 2026-08-29 定位裁定：gtv 保持只读，仅开两个例外——切换当前分支
（SAFE 携带语义，须带脏工作区确认）与分支/提交对比（纯读）。本 arc 落地
M3.1（git2 SAFE checkout 后端 + 脏确认对话框 + 当前分支泳道标记）与 M3.2
（Ctrl/Cmd 点击配对 + CompareDetails 对比面板）。设计文档：
`docs/superpowers/specs/2026-08-30-m3-checkout-compare-design.md`。

## Process

- Task 1（Rust `get_worktree_status` + `checkout_branch`，TDD）：先写
  `tests/checkout.rs` 七例（git CLI 造临时仓，`pagination.rs` 模式，每例独立
  临时目录）看红，再落实现。七例：干净切换（HEAD 简名 + oid + 工作区内容
  三重断言）、脏携带（改动随行 + 目标分支新增文件同步生效）、冲突拒绝
  （Err 后 HEAD/文件内容/porcelain 原样零变化——验收核心）、merge 进行中
  拒绝且删 MERGE_HEAD 后恢复、untracked 不阻塞且文件保留、status 三态计数
  （改 2 建 1 + MERGE_HEAD 翻旗）、tag/origin-x 形态/不存在名全拒。
- 两处简报草图与 git2 0.20 实际 API 的偏差，按语义不变原则适配：
  1. `repo.statuses(None)` 拿不到 untracked——libgit2 的
     INCLUDE_UNTRACKED 是 opt-in（默认 flags=0），WT_NEW 永远不出现，
     untracked 恒 0。改为 `StatusOptions::new().include_untracked(true)`
     再 `statuses(Some(&mut opts))`，其余默认与 `git status --porcelain`
     一致（untracked 目录记单条，不递归）。
  2. `CheckoutBuilder` 没有 `.force(bool)`，安全模式是独立方法
     `.safe()`（libgit2 默认即 SAFE）。显式调用 `.safe()` 而非依赖默认
     ——无 force 是本命令的安全契约，值得在调用点写成明文。
- 计数只收 spec §4.1 枚举的两桶：WT_MODIFIED/WT_TYPECHANGE/WT_RENAMED 计
  modified（用 `intersects` 而非精确 match——一条 entry 可同时带
  INDEX_* 位），WT_NEW 计 untracked；WT_DELETED 有意不计入（spec 未列，
  不擅自扩桶）。merge_in_progress 探测 `find_reference("MERGE_HEAD")` 或
  `CHERRY_PICK_HEAD` 伪引用——libgit2 的 refdb 会从 $GITDIR 直读这两个
  伪引用，测试实证有效。
- checkout 顺序铁律「先树后头」：`find_branch(name, Local)`（tag/远端名/
  不存在在此自然失败，同错误串 "Branch not found: {name}"）→ 取 tip 的
  tree → `checkout_tree(tree, SAFE)` → 成功后才 `set_head("refs/heads/<name>")`。
  冲突时 SAFE 在写前失败，HEAD 未动（测试三重钉死）。merge 拒绝错误串定
  死 "merge or cherry-pick in progress"（英文 ASCII，测试精确断言）。
- 命令层零新语义：clone `current_path`（短持锁）→ `spawn_blocking` 里开
  全新 `GitReader`（照 `open_repository` 模式）→ 返回 ack。`CheckoutAck`
  只含 `{ branch }`，绝不返回 GitData、绝不碰 AppState 的 view/session
  ——刷新全权交 watcher 的 repo-changed 链路（spec §4.3 防双重建竞态）。
  `AppState.current_branch` 语义错位不修不删（spec §8）。
- 测试踩坑一记：helper `git_out` 全量 trim 会吃掉 porcelain 输出的行首
  状态列空格（`" M x.txt"` 被修剪成 `"M x.txt"`），冲突零变化断言误判；
  改为对该断言读原始 stdout 字节 `b" M x.txt\n"`。期望值落笔前重数
  （M1.3/M2 教训）——本 arc 首例翻车在 trim 语义而非计数，同族教训。
- 门禁实况：cargo test 42 过（新增 7）；tour_repo 2 例失败为既有状态
  ——fixture 是 contentless gitlink（mode 160000），fresh clone 里永远
  NotFound，与本次改动无关。npm test 73/73 全绿（简报写 65 是 M2 时代
  的旧数，M1.3 arc 后 locate/terminalSize 已加 8 例）。npm run build 过
  （types.ts 镜像编译，chunk >500kB 警告为既有）。
