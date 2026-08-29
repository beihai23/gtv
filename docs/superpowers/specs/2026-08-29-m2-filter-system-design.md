# M2 过滤系统补完 — 设计文档

日期：2026-08-29
状态：已与用户逐项确认
Roadmap：M2（过滤系统：2.1 关联分支 / 2.2 日期范围 / 2.3 remotes 开关 /
2.4 关注集持久化）
Backstory：docs/work-backstory/filter-system-m2.md（本 arc 建立）
前置：inactive-lane-collapse arc（M1.2，collapseLanes/computeInactive 展示
变换与死泳道不变量）；commit-search-m1-3 arc（locate 管道）；branch panel
既有选择链路（selectedBranches → filter_by_branches 重建）。

## 1. 背景与目标

gtv 已能在大仓库上"打开即用"（M1.2 收拢 + M1.3 全史定位），但"只看我现在
关心的东西"还不是一等能力：想顺着一条 feature 看血缘得手动在面板里翻勾选，
origin/* badge 与本地分支同屏刷屏，每次重开仓库都要重新挑一遍分支，日期
维度完全没有。

**验收**（逐项）：
- 2.1 右键泳道 →「只显示相关分支」：目标泳道的血缘链（祖先 fork 链 +
  子孙 + merge 对象）保留，其余整体隐藏；区别于 Focus（仅弱化）。
- 2.2 顶栏下拉：本周 / 本月 / 近3月 / 近1年 / 全部 + 自定义起止；与压缩
  正交叠加；时间轴与刻度只覆盖范围内。
- 2.3 一键隐藏 origin/* badge，标签噪音减半；泳道标签不受影响。
- 2.4 重开仓库自动恢复上次的分支选择（按仓库持久化）。

## 2. 需求决策记录（用户逐项拍板）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 范围排期 | **全 M2 一个 arc**，四件套一次交付 |
| 2 | 2.1 实现载体 | **复用分支选择**：算出血缘闭包后直接 setSelectedBranches(闭包) 走 filter_by_branches 重建——结果在面板可见、可增删、All 一键撤销，零新机制 |
| 3 | 2.2 机制 | **前端显示变换**（M1.2 同路数）：纯函数过滤 + x 裁剪，纯函数可测、与分页/压缩正交 |
| 4 | 2.3 过滤范围 | **全部 origin/\* badge**：泳道左侧标签用短名，与 badge 无关，隐藏不丢信息；fresh clone 场景语义一致 |

## 3. 方案总览

**M2 四项全部是前端改动，Rust 后端零改动。**

- 2.1 复用 `filter_by_branches` 既有命令（种子过滤重走），新增的只是前端
  一个闭包纯函数 + 右键菜单项。
- 2.2 纯显示变换，不触后端 walk（否决 revwalk since/until 重走：每改一次
  范围一次 IPC + 分页 session 又一套接管复杂度）。
- 2.3 后端早已把 origin/x 并入同名本地泳道（collect_lane_seeds 去重），
  remote-only 分支也有短名泳道；is_remote 标志前端从未消费——现在消费它。
- 2.4 localStorage 按仓库路径存 selectedBranches。

四件共享一个落点：**分支选择集（selectedBranches）是唯一的事实源**。
2.1 产出选择集、2.4 持久化选择集、2.2/2.3 是选择集之上的显示层变换。

## 4. 组件设计

### 4.1 关联分支过滤（新纯函数模块 `src/related.ts`）

```
relatedLanes(data: GitData, target: string): Set<string>
```

数据基础（全部已在 GitData 里）：`BranchLane.fork_point`（fork 点 commit
oid）、`BranchLane.merged_into`（merge commit oid）。oid → lane_owner 的
映射从 `data.commits` 建（layout 的 lane 指派前端可见）。

定义（spec 语言，测试照此写）：
- `forkParent(L)` = L 的 fork_point oid 所属泳道（oid 不在已加载窗口 →
  不可解析，视为无父）；
- `mergeTarget(L)` = L 的 merged_into oid 所属泳道；
- **上链**：target → forkParent(target) → forkParent(forkParent(target)) →
  …（单线向上，不分叉）；
- **子孙**：从 target 沿反向 fork 边 BFS（所有 fork 自 target 或其子孙的
  泳道；向下分叉合法——都是子孙）；
- **merge 对象**：对 {target} ∪ 上链 ∪ 子孙 中每条泳道，并入其
  mergeTarget（单跳，不再传递）；
- **main 兜底**：`data.main_branch` 始终在集合里——fork_point 落在已加载
  窗口外时上链被截断，基座必须保底。

**兄弟分支明确排除**：同样 fork 自 P 的另一条分支不属于 target 的血缘
（上链单线不分叉天然排除；这是与"无向闭包"的关键区别）。

交互：泳道右键菜单（Timeline 现有三项之后）加「只显示相关分支 / Only
related branches」→ `onRelatedBranch(name)` → App 用**原始 gitData**（非
显示层副本）算闭包 → `handleFilterChange([...闭包])`。重建后面板里闭包
外的分支进 Disabled 组，All 一键复原；结果作为选择集自动被 2.4 持久化。

右键 main 的行为是诚实的：main + 所有 fork 自 main 的分支 + 它们的 merge
对象 ≈ 大半个仓库——用户要的就是 main 的血缘，不特殊处理。

### 4.2 日期范围过滤（新纯函数模块 `src/daterange.ts`）

```
export type DateRange =
  | { kind: 'all' }
  | { kind: 'preset'; days: number }
  | { kind: 'custom'; start: number; end: number };  // epoch 秒，闭区间

applyDateRange(data: GitData, range: DateRange): GitData
```

- `all` → **原样返回同一引用**（不拷贝，下游 memo 依赖不变）。
- preset 锚点 = **已加载提交的最新 timestamp**（仓库本地"现在"），窗口
  [anchor − days·86400, anchor]。锚定 wall-clock 会让不活跃仓库的"本周"
  变空视图；锚定最新活动永远有内容。
- custom 用显式起止（UI 层 date input → epoch 秒）。

变换内容（全部纯函数）：
1. commits 按 timestamp ∈ 窗口过滤（闭区间）；
2. **x 裁剪**：`x' = x − minX(可见提交)`——纯平移不改密度（保持
   px/day 语义，缩放手感不变）；M1.2 的"x 永不移动"不变量是收拢特征的
   约束，本特征是数据级裁剪，**有意打破并记录**；
3. time_gaps：裁剪到可见 x 区间后同样平移，空区间丢弃；
4. edges：**两端都可见才保留**（左缘提交呈现为泳道起点，不画悬空边）；
5. has_more / branches 原样。

**空泳道沉底**：窗口内零提交的非 tag 泳道直接构造 dead map（merged_into
有值 → archived，否则 dormant），与 computeInactive 的 dead map **取并集**
（范围空规则叠加在时长规则之上：90 天内活跃但本周无活动的泳道，在"本周"
视图里也是空的）后走既有 `collapseLanes`——空泳道噪音沉入痕迹行，面板
分组计数与展开机制原样复用。App 组合顺序：

```
gitData → applyDateRange → computeInactive(过滤后数据) → dead 并集 → collapseLanes → Timeline
```

刻度尺自洽性：Timeline 的 timeToX 以提交自身为锚点分段线性插值
（每 timestamp 均值 x），纯平移后自动一致，无隐藏全局比例。

UI：顶栏 locate 输入框旁一个下拉（全部/本周/本月/近3月/近1年/自定义）；
选「自定义」展开起止两个 date input。切换即生效并重置视口
（viewResetKey）。dateRange 是会话态，**不持久化**（重开仓库默认全部，
避免"我的图怎么被切掉了"的困惑）。

与分页正交：loadOlder 追加后过滤重算；preset 锚点取 max timestamp，
追加只会更旧，锚点稳定。

### 4.3 remotes 开关（`src/refs.ts` + 既有 Settings 管道）

```
filterRefs(refs: BranchRef[], hideRemotes: boolean): BranchRef[]
```

- 设置项 `gtv_hide_remotes`（默认 false = 现状显示），SettingsProvider
  加 hideRemotes/setHideRemotes，模式照抄 showStaleBranches。
- UI：顶栏 tags 开关旁一个 Remotes 开关（一键切换，与 tags 同形态）。
- 消费点五处全部过滤后再用（badge 的 slice(0,2) 与计数都要在过滤后算）：
  1. Timeline 画布 badge（含 `<title>` 全名列表）；
  2. Timeline 悬停 tooltip chips；
  3. CommitDetails 面板 chips；
  4. locate 的 matchLoaded 分支名匹配（is_remote 的 ref 名不参与命中，
     但同名本地 ref 仍命中——不被开关影响）；
  5. refActivity 只读排序，不滤（无害）。

### 4.4 关注集持久化（App 内 effect + localStorage）

- key：`gtv_branch_sel:<repoPath>`，value：JSON string[]。
- 保存：selectedBranches 变化即写（点击节奏，无需防抖）。
- 恢复：打开仓库成功、拿到全量分支表后——`valid = saved ∩ 当前分支名`；
  `valid` 非空且是真子集 → `setSelectedBranches(valid)` +
  `filterByBranches(valid)` 重建（一次子集 walk，开销远小于打开本身）；
  `valid` 为空或等于全集 → 默认全选（不重建，不闪二次加载）。
- 恢复helper 提为纯函数 `restoreSelection(saved: string[],
  available: string[]): string[] | null`（null = 走默认），可单测。
- 2.1 的闭包选择、面板手工勾选、双击 solo 全部走同一保存路径——
  「日常只关注几个分支」的完整闭环：挑一次，重开即恢复。

## 5. 边界情况

- **fork_point 在加载窗口外**：上链截断，main 兜底保基座；重建后后端按
  全史重算 lane 结构，视觉无不一致（闭包集合是近似，结构是真算）。
- **2.1 作用在已过滤视图上再点一次**：闭包在当前 gitData（已只含相关
  分支）上计算 = 同一集合，幂等。
- **2.2 窗口内零提交**：commits 空、ruler 不建（现有 `length > 1` 守卫）、
  全部泳道沉底——视图呈现两条痕迹行 + 空画布，提示性可接受。
- **2.2 自定义 start > end**：UI 层禁止（input 顺序约束 + 提交前校验），
  纯函数按空窗口处理（防御）。
- **2.4 分支已删除**：∩ 当前分支名自然剔除。
- **2.4 全选保存后恢复**：等于全集 → 跳过重建（视为默认态）。
- **死泳道不变量（M1.2）**：面板死泳道 chip 只切显示不改选择集——本 arc
  不碰该路径；2.1 的 handleFilterChange 会整体替换选择集，闭包外的死泳道
  不进 walk、不进痕迹行，面板分组相应缩小，语义一致。

## 6. 测试与验收

纯函数（vitest，新文件）：
- `src/related.test.ts`：上链单线、子孙分叉、merge 对象单跳、兄弟排除、
  main 兜底、fork_point 不可解析截断、幂等。
- `src/daterange.test.ts`：all 恒等（同一引用）、preset 窗口锚定最新
  ts、custom 闭区间、x 平移量、gap 裁剪/平移/丢弃、边双端规则、
  空泳道 dead map 的 archived/dormant 分类。
- `src/refs.test.ts`：过滤语义（is_remote true/false 混合）。
- `restoreSelection` 单测：交集、空、全集 → null。

E2E（mock.html + browse，端口 1421）：
- 2.1 右键泳道 → 菜单第四项 → 泳道数收缩、面板 Disabled 组出现、
  All 复原。
- 2.2 下拉切"本月" → 提交数下降、刻度范围收缩、泳道沉底痕迹行出现、
  切回"全部"复原。
- 2.3 开 Remotes 开关 → 画布无 origin/* badge（mock 数据若缺 remote ref
  则临时补 fixture），详情面板同步。
- 2.4 勾选两个分支 → 刷新页面重开 → 选择自动恢复（mock 的
  getCurrentPath 恒返回 /mock/taskon-server，localStorage 路径键稳定）。

## 7. 明确不做（本 arc 范围外）

- 后端任何改动（无新命令、无 walk 语义变化）。
- 多词/正则搜索、按 remote 选择性显示（只一个总开关）。
- dateRange 持久化、expandedDead/focusedLane 持久化（只持久化选择集）。
- 无向闭包/兄弟分支纳入（明确排除，见 4.1）。
- ahead/behind 徽标（M4.4 的事，隐藏 remote badge 不顺手做计数）。

## 8. 风险与注意点

- **M1.2"x 永不移动"不变量被 2.2 有意打破**：仅限日期裁剪路径；收拢
  变换仍在裁剪之后运行且自身不动 x。两变换组合顺序固定（先裁剪后收拢），
  App memo 依赖链要按此排。
- **闭包近似性**：relatedLanes 只见已加载窗口内的 fork 结构；深历史
  fork 父链缺失由 main 兜底。若真实使用中发现漏保（如 fork 自
  release/v2 的链），M2.1 后续可加"未解析 fork_point 的种子也并入"——
  本 arc 不做，先验证主路径。
- **2.4 恢复触发二次 walk**：打开（全量）+ 恢复（子集）串行；大仓库
  打开本就是重头，子集 walk 是增量成本，验收时不设额外预算。
- **badge 计数漂移**：hideRemotes 后 slice(0,2)/extra 计数必须基于过滤
  后列表，否则出现"+1"却点不出内容的幽灵计数（review 重点盯）。
