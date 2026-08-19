# gtv 重设计 v2 —— 以 Branch Explorer 为参照系

> 前置阅读：`docs/gmaster-research.md`（参照系资料）+ 上一轮代码走查结论。
> 本文回答三个问题：要长成什么样（§1-2）、核心算法怎么做（§3）、分几步走（§5）。

## 1. 设计愿景

**gtv = 用纯 git 数据复刻 gmaster Branch Explorer 的那块"黑板"。**

一句话体验目标：打开任意 git 仓库，3 秒内看出"有几条分支、各自从哪里生、在哪里合、
哪条线最近最活跃"——不需要读任何一条提交信息。

设计原则（从 Branch Explorer 反推）：

1. **分支是一等公民，提交是分支上的事件。** 视觉主体是泳道（分支的生命轨迹），不是节点。
2. **默认压缩，按需展开。** gmaster 视频证实：Branch Explorer 默认隐藏非关键提交，
   只保留 fork 点 / tip / merge 源与目标 / 带 tag 的提交（详见 §3.6）。
   泳道图的可读性靠"克制"，不靠"全量"。
3. **x 轴是真实时间。** 时间不成比例就不是时间轴，只是换了个方向的 git log。
4. **图结构即真相。** git 不存分支元数据，所有 fork/merge/归属关系从 DAG 推导，
   推导规则必须确定、可解释、可测试。
5. **先读对，再好看。** P0 只做"把泳道画对"；视觉增强（节点大小、迷你图）全部后置。

## 2. 信息架构与数据模型

### 2.1 概念模型

```
Lane（泳道）        = 一条分支的一段连续生命 [fork_point, merge_point_or_tip]
  ├─ tip_ref       指向的引用（分支名；可能已被删除 → "ghost lane"）
  ├─ fork_point    出生点（父泳道上的某个提交；main 没有）
  ├─ merge_point   收拢点（合入目标泳道的 merge 提交；未合并则没有）
  └─ commits       属于本泳道的提交，按时间排列

CommitNode         增加：additions / deletions / lane_owner（泳道名）
Edge               Direct（同泳道相邻）/ Branch（fork 出生线）/ Merge（汇合线）
Tag                不再是 Lane，是挂在 CommitNode 上的徽标
```

### 2.2 models.rs / types.ts 变更

```rust
// CommitNode 变更
pub struct CommitNode {
    // ... 现有字段保留
    pub lane_owner: String,            // 新增：归属泳道名（替代模糊的 lane: i32 语义）
    pub additions: u32,                // 新增：diff stats
    pub deletions: u32,                // 新增
    // fork_branch_name / merge_branch_name：保留字段名，现在开始真正赋值
}

// BranchLane 变更
pub struct BranchLane {
    pub name: String,
    pub lane_index: i32,
    pub color: String,
    // is_tag 字段删除 —— tag 不再占泳道
    pub fork_point: Option<String>,    // 新增：出生点提交 id
    pub merged_into: Option<String>,   // 新增：收拢点 merge 提交 id
    pub is_active: bool,               // 新增：分支引用当前是否还存在（区分 ghost lane）
}

// CommitNode.branch_refs 中的 tag 保留（徽标渲染用），但不再进入 BranchLane 列表
```

### 2.3 配色收口

现状：三处调色板不一致（git_reader.rs:38-46、261-264、502-505），chips 和泳道可能对不上。
改为：**单一来源** `fn lane_color(index: usize) -> &'static str`，main/master 固定
`#4A90D9`，其余按 lane_index 取模；tag 徽标固定紫灰（`#9C27B0`），不进调色板轮换。

## 3. 核心算法：泳道传播（替换 git_reader.rs:344-358）

### 3.1 输入与不变量

- revwalk 起点从 `push_head()` 改为 **push 所有本地分支 tip**（顺带修复"未合并分支
  不可见"）；排序 `TIME | TOPOLOGICAL` 不变。
- 不变量：每个提交恰好属于一条泳道；每条泳道在图上是一段连续时间区间。

### 3.2 两遍法

**第一遍：主线认领（mainline claim）**

```
从 main tip 出发，沿 first-parent 链回溯，沿途所有提交标记 lane_owner = main
（first-parent = merge 提交的 parents[0]，即"合并发生的方向"）
```

**第二遍：分支认领（branch claim），按优先级降序**

```
分支排序：main 最先（第 0 泳道），其余按 tip 提交时间倒序（越新越靠内/先认领）
对每个分支 B：
  从 B.tip 沿 first-parent 回溯：
    - 提交未被认领 → 认领给 B
    - 撞上已认领提交 P → P 即 B 的 fork_point；停止回溯
      （P.lane_owner 即 B 的父泳道）
```

直观示意：

```
main     ──●──●──●───────●────────●──▶        （● = main 认领）
                \        ↑merge    ↑
                 \Branch  │        │Merge
feature-A        ●──●──●──┘        │
                  ↑fork_point      │
hotfix           ──────────────────●──●──▶
```

**第三遍：边与标注生成（顺带填上所有空字段）**

```
对每条边 (commit → parent)：
  两者同泳道                → EdgeType::Direct
  commit 是 merge 提交、
  parent 是 parents[1..]    → EdgeType::Merge，并给 commit.merge_branch_name
                              赋 parent 的泳道名
  parent 是某泳道的
  fork_point 且 commit 是该
  泳道首提交                → EdgeType::Branch，并给 parent.fork_branch_name
                              赋该泳道名
```

### 3.3 泳道纵向排序

- lane 0 = main。
- 其余泳道按 **fork_point 的时间** 从上到下排列：生得越早、离 main 越近。
- 收拢后的泳道不复用（v2 不做压缩，见 §5 P2）。

### 3.4 x 坐标：真实时间比例

```
x = (timestamp - t_min) * px_per_second，px_per_second 自适应到可用宽度
约束：key commit 按全局时间序做最小间距 28px 的单调右推（所有泳道共享同一条
     单调 time→x 曲线；per-lane 右推会让同一时间在不同泳道落在不同 x，时间尺无法对齐），
     非 key commit 插值在相邻 key 锚点连线上，保证密集提交不叠点且任意 commit 与顶部时间尺对齐
```

### 3.5 边界情况（必须进测试）

| 场景 | 期望行为 |
|---|---|
| 仓库只有一条分支 | 单泳道，等价线性时间轴 |
| 分支已删除但已合并（ghost lane） | 泳道照常画出，`is_active=false`，名字用合并信息推断（如 merge message 里的 `Merge branch 'X'`） |
| 分支从未合并 | 泳道延伸到 tip，无收拢边 |
| octopus merge（>2 parents） | parents[1..] 各产生一条 Merge 边 |
| root 提交 | diff 对空树计算，文件全部 status=A，行数正常统计 |
| 泳道数 > 调色板长度 | 取模复用，靠泳道名标签消歧 |

### 3.6 智能节点压缩（gmaster 的信息密度答案）

视频证实（0:32-0:48）：Branch Explorer 默认不展示全部提交。gtv 采用同一规则：

```
一个提交被保留（relevant），当且仅当：
  - 是某泳道的首提交（fork 出生点）或末提交（tip / merge 源）
  - 是 merge 提交（merge 目标）
  - 携带 tag 或分支引用
  - 是 HEAD
其余提交折叠进泳道横杠：该段画成纯横线，节点不渲染。
交互：横杠段悬停显示 "N commits collapsed"，点击展开该段（展开状态为视图态，
不改数据模型）；顶栏提供 "Expand all" 开关。
```

效果：2000 条提交的仓库，默认视图通常只剩 O(分支数 × 2 + merge 数 + tag 数)
个节点——这正是 gmaster 截图里只有十几个节点的原因。

## 4. 渲染与交互规格（Timeline.tsx 改造点）

### 4.0 图形词汇（对齐 gmaster 截图，docs/assets/ 三张）

- **节点字形**：圆形内嵌水平短杠（⊖）；tip 节点用实心内点区分；HEAD 节点
  家形图标 + 绿色 "HEAD" 文字标签。
- **分支名标签**：彩色圆角矩形，放在泳道右端 tip 附近；同泳道多个引用垂直堆叠
  （origin/master 在上、master 在下）。不再挂在每个节点上。
- **fork 线**：直角折线——父泳道节点向下 90° 垂落再水平接入子泳道首节点
  （gmaster 风格，不用贝塞尔）；**merge 线**：细浅色曲线斜向汇入主线 merge 节点，
  视觉权重明显低于泳道横杠与 fork 线。
- **顶部时间标尺**：随 zoom 更新的日期刻度（截图中的 "12/30/2016 … 12/31/2016"）。
- **顶栏**：Filters 按钮 + 分支 chips（保留现有）+ 日期范围选择器
  （gmaster 是 "last 2 years" 式相对范围下拉）。

### 4.1 P0 必做（配合算法落地）

- **分支横杠**：每条泳道在其 `[首提交x, 末提交x]` 区间画一条 4px 圆角横杠，颜色 =
  泳道色，透明度高于节点（这是 Branch Explorer "select the bar" 的图形基础，
  P3 给它挂交互）。
- **节点颜色 = lane_owner 的颜色**，不再遍历 branch_refs 猜颜色（Timeline.tsx:137-143）。
- **fork 出生线 / merge 汇合线**：Branch 边用短促向下/向上的 S 曲线 + 出生点标注
  （泳道名，9px，泳道色）；Merge 边用平缓汇入曲线 + 收拢点标注。
  前端渲染壳已在（Timeline.tsx:168-190），后端开始赋值后自然点亮。
- **tag 徽标**：节点上方的 pill 标签，不占泳道。
- **HEAD 标记**：当前 checkout 位置的节点加"家"形外圈（对应 Branch Explorer 的
  home icon）。
- **泳道名标签**：画布左侧固定列（不随 zoom 平移滚出视野）。

### 4.2 P1 视觉增强

- **节点大小编码变更量**：`r = 6 + 8 * sqrt(add+del) / sqrt(p95(add+del))`，
  上限 14px。对应 "identify the commits with more changes at a glance"。
  数据源：`diff.stats()`（git2 支持），替换 get_commit_detail 里恒 0 的占位
  （git_reader.rs:433-438），并新增批量统计接口供主时间线使用。
- 时间轴网格：底部月份/日期刻度线（真实时间轴的必需品）。

### 4.3 P2/P3 交互（按 Branch Explorer 的"操作入口"哲学排布）

- P2：**关联分支过滤**——右键泳道 → "仅显示选中及关联分支"（保留其父泳道链 +
  子泳道 + merge 关联方，对应 gmaster "Show selected and related branches"）；
  日期区间过滤；显示选项（隐藏 merge links / 隐藏 tag / 截断分支名）；
  迷你导航图（对应 navigation panel）。
- P2：**详情三栏联动**——点选提交后右侧属性面板 + 变更文件列表（带 +/- 行数）
  + 底部 diff 区，内嵌联动而非独立面板（对齐 gmaster 截图布局；
  CommitDetails.tsx 重构为右栏 + 底部抽屉）。
- P3：点横杠选中整条分支 → 右键菜单（checkout <branch>——把已实现但前端从未调用的
  `switch_branch` 接上；diff 两提交——配合 Ctrl+点击多选）。
- 分支过滤修复（git_reader.rs:652）：从"refs 指向的提交"改为"从选中分支 tip 各自
  revwalk，取并集"，过滤语义从"只剩 tip"变为"显示这些分支的完整血缘"。

## 5. 路线图

> 2026-08-18 起，路线图以 [roadmap.md](roadmap.md) 为准；本表是设计文档写作时
> 的原始分期，P0–P2 已完成，留作历史记录。

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 泳道正确性** | §3 算法落地；all-tips revwalk；tag 不占泳道；配色收口；HEAD 标记 | 打开一个"main + 2 feature 分支（其一已合并、其一未合并）+ 3 tags"的 fixture 仓库，每个提交落在正确泳道；截图与 `git log --graph --all` 结构一致 |
| **P1 信息密度** | **智能节点压缩（§3.6）**；diff stats + 节点大小编码；真实时间比例 x 轴 + 顶部时间标尺 | 默认视图只显示关键节点，折叠段可点击展开；大变更提交肉眼可辨；相隔一月的两个提交明显比相隔一分钟的远 |
| **P2 视图控制** | 关联分支过滤；日期过滤；显示选项；迷你导航图；分支过滤语义修复；详情三栏联动 | 复刻 Branch Explorer 过滤三层（压缩/关联分支/日期）+ display options 最小子集 |
| **P3 操作入口** | 横杠选中 + 右键 checkout/diff；接通 switch_branch | 只读查看器 → 轻量操作入口 |

## 6. 工程化配套（与可视化无关但必须做）

1. `git init`：项目本身至今不是 git 仓库——一个 git 可视化工具不能没有自己的历史。
2. 测试基建：分两层——
   - **合成 fixture**：`src-tauri/tests/` 下用 git2 编程式构造仓库（覆盖 §3.5 表），
     断言每个提交的 lane_owner。这是泳道算法敢迭代的前提。
   - **基准仓库**：`docs/reference/gmaster-tour/`（gmaster 官方 tour 仓库的 fork 存档，
     14 提交 / 7 分支 / 已合并+未合并+分支套分支）。集成测试断言该仓库的泳道归属，
     并以视频截图（docs/assets/）做人工视觉比对——这是唯一有"标准答案"的真实仓库。
3. 清场：删 App.tsx/Timeline.tsx 的 console.log；README 换成项目自己的
   （愿景 + 截图 + 快捷键 + 开发命令）。
4. 架构小改：`calculate_layout` 从 `GitReader` 拆出为纯函数模块 `layout.rs`
   （输入 commits+refs，输出坐标），让算法可以脱离 Tauri 单测。
