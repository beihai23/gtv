---
arc: large-repo-pagination
started: 91776b7
status: resolved
commits: [aa0a793, 2fe7b9f]
---

# 大仓库打开优化与渐进式分页加载

## Intent

起点是一个问题："大仓库的打开速度还有优化空间吗？"（以 taskon-server，6292 commits 为参照）。
打开路径当时存在结构性浪费，且 2000 commit 的硬上限让大仓库的历史不可达。
目标：打开更快 + 完整历史可回溯，且不牺牲图结构完整性。

## Process

- **第一刀：消除重复流水线。** `get_branch_list` 内部曾完整重跑一遍 `build_view`
  （revwalk 2000 + layout + 150 次 tree diff），只为拿 lane 颜色。改为复用
  `AppState.current_view` 的缓存视图，打开耗时直接减半。这是性价比最高的修复。
- **第二刀：150 次 diff 统计移出打开路径。** 节点大小所需的 additions/deletions
  原是打开时串行计算的 150 次 tree diff，是大仓库打开耗时的常数项大头。改为
  首屏渲染后异步批量补取（新命令 `get_commit_stats`，仍封顶 150，最新优先），
  节点半径随后补上。曾因 replace_all 的缩进子串误匹配产生重复插入，教训：
  同一文件多处相似文本的批量替换必须带足够上下文。
- **用户提议：按时间对数稀疏采样旧历史（最近 1000 全取，越久远越稀疏）。
  被否决。** commit 不是时间序列上的独立采样点——gtv 的价值全在拓扑（lane 链、
  fork/merge 点），而 `layout.rs` 对"父 commit 不在已加载集合"的边是静默丢弃的，
  稀疏化会把 lane 打成碎片，且恰好容易丢掉 merge/fork 这些结构节点。另外模型里
  已有 `time_gaps` 折叠，"久远"在横轴上本就被压缩，时间稀疏解决的是不存在的痛点。
- **正解：渐进式分页。** 每视图先走最新 2000 个，滚到左缘自动续走
  （`load_older_commits`），因为 lane 归属和 x 坐标是全局量（x 由最老 commit 起
  级联），每次加载更多后**整图重排**，前端按"视口中心最近的 commit"锚定恢复视口。
- **关键意外 #1：`revwalk.hide()` 不能用于分页续走。** hide 把 oid 标记为
  uninteresting 并**传播到所有祖先**，会把正要加载的旧历史整个掐掉（测试实测：
  第二块只返回 1 个 commit——唯一不被任何已加载 commit 祖先链覆盖的 stale tip）。
  改为遍历时跳过已加载 oid，代价是每块重走已加载前缀（亚秒级，可接受）。
  revwalk 无法常驻 AppState（git2 生命周期不允许自引用结构）。
- **关键意外 #2：`layout.rs` 排序键 `-ts` 溢出。** tip 不在窗口时 ts 取
  `i64::MIN`，取负在 debug 构建直接 panic，release 下静默 wrap 成错误顺序。
  改用 `Reverse(ts)`。这是既有的潜伏 bug，被新的分页测试揪出（tour_repo 的
  14 个 commit 永远不会触发它）。
- **stale 分支开关是用户明确要求。** 定义：tip 不在当前 revwalk 窗口内的分支。
  开关关（`gtv_show_stale`，设置页）时 stale 种子从分页 session 剔除——其独有
  commit 只可能从 stale tip 到达，因此永不加载，分支面板也不显示。显式
  "从此分支查看"不受开关影响。
- **minimap 浅色主题不可见是既有 bug，由用户截图暴露。** 圆点硬编码 `#fff` 画在
  浅色背景上完全消失，lane 条 opacity 0.75 也太淡。先用 `--text` 变量修复，结果
  浅色下变成"黑乎乎一团"；最终改为与主图一致的 lane 色（`branchColorMap`），
  两个主题下都与主图配色对齐。排障手段值得记录：`dump_paged` 工具 dump 全量分页
  数据证明后端健康 → playwright + mock.html 双段数据模拟分页过渡 → 3x 元素截图
  逐层隔离，最终用"bar 加粗到 6px 就完全正常"定位到纯粹是颜色/淡度问题。
- **commit 计数显示的分歧。** header 的 "2000 commits" 在分页后变成误导。曾考虑
  显示仓库真实总数，但那需要一次完整 revwalk 计数，违背本次优化的初衷。最终显示
  "2000+ commits"（has_more 时），分页到尽头后显示精确值。
- **护栏：** `get_patch_links`（每 commit 一次 diff）封顶最新 4000 个，防止视图
  分页到 10 万级后检测爆炸。

## Decisions

- 分页加载 > 提高上限 > 时间稀疏采样（否决）> 结构折叠（信息有损，暂不做）。
- 每次续走整图重排是唯一正确选择：lane 归属全局、x 级联全局、stale tip 进入
  窗口时会新增 lane 并改写既有归属。
- 分页正确性的核心测试断言：**分页终态 == 一次性全量 walk 的 lane 归属**
  （`tests/pagination.rs`），外加向下封闭（已加载 commit 的子节点都已加载）。
- 测试基建：临时仓库用 git CLI 造（`relative_worktrees_ext.rs` 的既有惯例），
  提交时间用 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` 钉死保证确定性。

## Lessons

- `revwalk.hide()` 语义 = git rev-list 的 `^exclude`，uninteresting 会向祖先传播；
  "跳过已读集合"只能自己在遍历里做。
- debug 构建的溢出检查会抓住 release 下静默的整数溢出错误；涉及 `i64::MIN/MAX`
  哨兵值的取负/取反要格外小心。
- Tauri 应用的 UI bug 可以不用真机调试：vite dev + mock.html 替换数据源 +
  playwright 脚本即可复现完整交互路径（包括分页过渡状态）。
- 既有问题：`docs/reference/gmaster-tour` 是没有 `.gitmodules` 的 gitlink，
  本地是空目录，`tour_repo.rs` 两个测试因此无法运行（本次之前即存在，未修）。

## Related

- 核心改动：`src-tauri/src/git_reader.rs`（walk_commits/load_more/get_commit_stats）、
  `src-tauri/src/commands.rs`（ViewSession/include_stale/load_older_commits）、
  `src/components/Timeline.tsx`（视口锚定/加载触发/minimap 配色）
- 测试：`src-tauri/tests/pagination.rs`；工具：`src-tauri/examples/dump_paged.rs`
