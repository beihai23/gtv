---
arc: same-second-topo-order
started: 9787c17
status: resolved
commits: [4dc54c1]
---

# 同秒时间戳 commit 的拓扑排序修复

## Intent

用户发现 `origin/feature/task-name-list-main` 分支上多个 commit 的详情时间完全一样，
且图上排序看起来是反的。需要查清是数据问题还是排序 bug。

## Process

- 先用 git 验证数据本身：该分支 7 个 commit 的 committer 时间戳完全相同
  （`1775713427`），是一次 rebase 在一秒内重写出来的；author date 其实相差
  约 3 小时。详情面板显示的是 committer date（git log 默认显示 author date，
  所以用户在普通 git 工具里看不到这个现象）——"时间一样"是真实数据，不是显示 bug。
- 用 `dump_json` 对真实仓库（taskon-server, 6292 commits）dump 后坐实了两个真 bug：
  1. 分支 tip `fb509e6` x=7357.1，比自己的祖先 `462d706` x=7385.1 还靠左——整条
     链画反。根因：revwalk 是新的在前，`layout.rs` 的 `sort_by_key(timestamp)`
     是 stable sort，同秒组内保持"子在前父在后"的 walk 顺序，min-spacing cascade
     按这个反序发 x 坐标。
  2. 中间 5 个非 key commit 全部叠在同一个 x=7396.3。根因：pass 2 对"与 key
     commit 同秒"的分支只给一个固定偏移 `key_x + 0.4*MIN_SPACING`，同秒的非 key
     commit 全部落同一点。另一个潜在问题：最后一个 key 之后的非 key commit 原来
     全部取最后一个 key 的 x，同样重叠。
- 修复方案：排序键加拓扑深度 tiebreak（`topo_depth()`，最长路径深度，迭代式后序
  遍历——10k commit 窗口递归会爆栈）；pass 2 改为 bracket walk：非 key commit 在
  相邻 key 构成的区间内按 `max(时间分数, 均匀名次分数)` 分散，再加单调级联兜底，
  保证严格递增。曾考虑纯时间分数 + 仅 cascade，但同秒簇只能挤在 2.3px 间隔里，
  rank 分数能均匀撑满 bracket（28px 内 5 个约 4.7px），视觉更好。
- 确认过前端 ruler 不受影响：ruler 的锚点是"每个时间戳的平均 x"（Timeline.tsx
  byTime 聚合），同秒 commit 怎么分散都锚到同一秒，且单调性由 `Math.max` 强制。
- 验证：新增纯图测试 `same_second_commits_order_topologically`（同秒 5 链，
  输入故意按 walk 的新到旧顺序）；真实仓库重新 dump 后 7 个 commit 均匀排开、
  tip 最右，全部 2063 条边中同车道反向边为 0。

## Decisions

- 详情面板继续显示 committer date，不改 author date：同秒是 rebase 的真实结果，
  显示没有错；author date 作为可选的后续增强（已向用户说明，未做）。
- tiebreak 用拓扑深度而非 author timestamp：author 时间在 cherry-pick 重排后同样
  可能违反拓扑，深度才是结构性正确的次序（"做对的事"）。

## Lessons

- rebase 会让一整条分支的 committer 时间戳塌缩到同一秒——任何"按时间排序"的图
  算法都必须有拓扑 tiebreak，否则 stable sort 会把输入顺序（walk 的新到旧）当成
  时间次序，父子方向直接画反。
- git log 默认显示 author date，排查"时间显示异常"时要分清 `%at` 和 `%ct`。

## Related

- `src-tauri/src/layout.rs`（`topo_depth`、pass 1 排序、pass 2 bracket walk）
- `src-tauri/tests/layout_pure.rs::same_second_commits_order_topologically`
- 姊妹 arc: docs/work-backstory/large-repo-pagination.md
