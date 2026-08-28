# M1.2 非活跃泳道收拢 — 设计文档

日期：2026-08-28
状态：已与用户逐节确认
Roadmap：M1.2（docs/roadmap.md，M1「大仓库日常可用」最后一项）
Backstory：docs/work-backstory/inactive-lane-collapse.md

## 1. 背景与目标

大仓库（1000+ 分支）打开后，几百条早已合并/废弃的死分支占满画布，默认视图
不可用。现有的 stale 开关（分页 arc 引入）是「tip 在已加载 revwalk 窗口之外」
的**加载**语义，不解决这个问题。

**验收**：1000+ 分支仓库打开后默认**活跃泳道数 ≤ 30**（不含两条痕迹行）；
死分支历史仍可达（展开后完整恢复）；x 轴坐标在任何收拢状态下不变（时间轴
诚实性）。

## 2. 需求决策记录（用户逐项拍板）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 收拢范围 | 已合并 + 长期未合并都收，分两组：「已归档」（merged）/「休眠」（未合并） |
| 2 | 阈值 | 90 天默认，设置页可调（30/90/180/365/不收拢）；判定基准 = 泳道 tip commit 的 committer 时间戳 |
| 3 | 图上形态 | 压缩痕迹行：死泳道不占独立行，lane bar 压进特殊薄行（只画 bar 不画节点） |
| 4 | 展开交互 | 面板分组勾选（单条恢复）+ 痕迹行点击整组展开；本次不持久化（跨会话记忆归 M2.4） |
| 5 | 长驻保护 | 确名名单（无通配）+ fork 父链结构闭包，任一命中即保留 |

保护名单（确名，每仓至多一两条，无界风险为零）：
`main master dev develop test testing uat staging sit qa prod production integration release hotfix`

`release/*`、`hotfix/*` **不进名单**：不清理的团队会堆几百条，名单一保护验收
就破产。活跃的 release/hotfix 由活动规则保住；有活跃后代的由 fork 闭包保住；
2023 年的老 release 归入已归档组——这正是它该在的地方。

## 3. 方案选择

**选 A：纯前端渲染层收拢**（零后端改动）。

- 否决 B（后端剔除重建）：打开多一次全量重建（大仓库二次等待）；x 随收拢
  变化（同一 commit 收拢前后位置不同，体验跳变）；展开要后端回程；分页
  session 重建语义复杂。
- 否决 C（后端打标 tip_ts/archived）：判定逻辑下沉后端，阈值变更需重新打开
  或传参；前端扫 commits 是 O(n) 一次，便宜。留作演进，首版不做。

选 A 的结构性红利：死泳道的 span 数据就在手边（痕迹行便宜）；收拢是纯视觉
状态，即时可逆；与分页天然兼容（新数据 → 重算即可）；后端零风险（Rust
测试面不变，只读承诺不涉）。

## 4. 组件设计

### 4.1 判定模型 — 新模块 `src/inactive.ts`（纯函数）

```
computeInactive(data, thresholdDays, expandedDead) → {
  dead: Map<laneName, 'archived' | 'dormant'>,   // 收拢集（不含已展开的）
  groups: { archived: BranchLane[], dormant: BranchLane[] },  // 面板用，含已展开
}
```

判定管线（全部基于已加载数据，O(n)）：

1. **泳道 tip 时间戳**：`max(timestamp)` over `c.lane === lane_index` 的
   commits（walk 的种子就是各分支 tip，tip 必在已加载集内）。**兜底**：ref
   挂在别的泳道 commit 上的"零自有 commit 泳道"（release/v1.x 型），用其
   ref 目标 commit 的时间戳作为最后活动时间——否则这类泳道逃过收拢，
   恰好砸坏验收 fixture。两者皆无的 lane 不参与判定（本就不可绘制）。
2. **活跃** = tip ts ≥ `now − thresholdDays × 86400`；`thresholdDays = 0`
   即「不收拢」，`dead` 恒空。
3. **保护名单**：确名精确匹配（大小写敏感，与 git 一致，见 §2）。匹配对象
   是 lane 的短名（不含 `refs/heads/` 前缀），**整名相等**才命中——
   `dev` 命中 `dev`，不命中 `feature/dev`。
4. **fork 父链闭包**：活跃泳道的 `fork_point` commit 的 `lane_owner` 链全部
   保留，迭代到不动点（出生关系是 DAG，天然收敛；仍加已访问集防环兜底）。
5. **归类**：非保护、非活跃 → `merged_into` 有值为 `archived`，否则
   `dormant`。`is_tag === true` 的伪 lane（get_branch_list 追加的 tag 条目，
   fork_point/merged_into 恒 None、无 commit 归属）**永不参与**。
6. `expandedDead` 中的泳道从 `dead` 排除，留在 `groups` 供面板显示勾选态。

结构性红利（无需额外规则）：merge 的目标泳道自动保鲜——吸收分支的 merge
commit 落在目标泳道上，其 tip 时间戳随之更新，近期被合入的 env 分支天然
不收。推论（预防一个表面悖论）：「活跃泳道的 merge 边落到隐藏节点上」不可
能发生——活跃泳道 F 的 tip 若被 merge commit M 吸收，M 是 F tip 的子提交、
落在目标泳道上且时间 ≥ F tip，故目标泳道 tip ≥ F tip 时间，必然也活跃。
同理，分支在 merge 后又继续提交的场景，layout 不会置 `merged_into`（吸收
的是旧 tip 而非当前 tip），归类为活跃，不受影响。

### 4.2 显示变换 — `collapseLanes(data, dead)`（与 §4.1 同在 `src/inactive.ts`）

不做「每个渲染点改走 rowOf」，而是 App 层做一次数据变换，渲染代码几乎不动：

```
collapseLanes(data, dead) → {
  data:  GitData'   // 浅拷贝结构，见下
  hiddenIds: Set<string>
  traceBars: Array<{ laneIndex: number, x1: number, x2: number, color: string }>
  traceRows: Array<{ laneIndex: number, kind: 'archived' | 'dormant', count: number }>
}
```

- **`lane_index` 直接重写为紧凑行号**（活跃泳道保持相对顺序压到 0..k），
  痕迹行占用其后的行号。**伪 lane 不进 `branches` 数组**（规划期修正：
  隐藏 commit 的 lane/y 指向痕迹行号后，lane-bar join 会借 laneSpan 画出
  一条合并 span 的伪 bar，rail chip 的点击语义也不同）——痕迹行的 bar 与
  chip 由 `traceBars`/`traceRows` prop 单独渲染，Timeline 拿到的
  `data.branches` 只含活跃泳道。现有 `lane_index * LANE_HEIGHT` 的渲染点
  （guides / bars / chips / minimap / +N chips）对活跃泳道原样工作。
- **commit 的 `y` 重写**为 `新行号 × LANE_HEIGHT`；收拢泳道的 commit 进
  `hiddenIds`，**不删除**（数据保留，展开零成本）。**隐藏 commit 的 y 一律
  改写为其所属组的痕迹行 y** —— fit 边界取全体 commits 的 y 极值，漏改则
  收拢后 fit 爆炸。
- **痕迹行渲染**：死泳道 bar 的 x-span 取**变换前**的 laneSpan（该泳道
  commits 的 `[min_x, max_x]`），画进对应伪 lane 行：原 lane 色 + 低透明度
  （叠加处自然加深，成「沉积层」质感），线宽 2px（活跃 bar 为 4px），不画
  节点、不画边。行内 chip 显示「已归档 N」/「休眠 M」。点击 = 整组展开。
- **可见性过滤**：现有 `visibleCommits` 链加 `!hiddenIds.has(id)` 条件；
  edges 的 `visibleIds` 过滤自动跟着对。
- **minimap**：lane 条用重写后的 lane_index（自动正确）；隐藏 commit 的
  圆点跳过。
- 变换在 App 层 `useMemo`，依赖 `gitData / dead / expandedDead`，纯函数不
  mutate 原 GitData（分页增量、diff stats 回填都依赖原对象）。

### 4.3 分支面板与展开交互

- 面板分组改为：**活跃组**（现有 enabled/rest 语义不变，勾选 =
  `filterByBranches` 后端重建）+ **已归档 (N) / 休眠 (M) 两组新分组**。
- 新分组条目带 checkbox：勾选 = `expandedDead.add(name)`，**纯前端展开**
  （该泳道恢复真实行），不走后端重建。组标题旁「全部展开/收拢」按钮与
  痕迹行点击等效。
- **All/None 只作用于活跃组**。
- **不变量**：`filterByBranches` 重建时传的名单 = 活跃选中集 ∪ 全部死泳道
  名（死泳道永远保持加载，只是视觉收拢）。否则取消勾选一个活跃分支会把
  死泳道从视图卸掉，分组和痕迹行就空了。
- **Cmd+F 搜索定位**到隐藏泳道的 commit 时自动 `expandedDead.add(该泳道)`
  （与「跳到压缩隐藏 commit 自动展开车道」的既有行为一致）；方向键导航只在
  可见 commits 间走。

### 4.4 设置

- 新增「不活跃泳道收拢」：阈值下拉（30/90/180/365 天/不收拢），默认 90，
  持久化 `gtv_inactive_days`。改动即时生效（重算判定 + 变换，纯前端）。
- **撞名处理**：现有 stale 开关中文标签「显示不活跃分支」改为「显示窗口外
  分支」（加载语义）；新功能用「不活跃泳道」（活动语义）。英文 stale 不动
  （"Show stale branches"），新条目 "Collapse inactive lanes / Inactive
  after"。

## 5. 叠加语义

| 场景 | 行为 |
|---|---|
| 分页续载 `load_older_commits` | 整图重排后对新数据重跑判定；`expandedDead` 按名保持 |
| 视口锚定恢复 | 「视口中心最近 commit」改为只在**可见** commits 里取，避免锚到隐藏节点 |
| 泳道聚焦（chip 弱化） | 不变（按名工作；隐藏泳道无 chip，不可能聚焦） |
| 从此分支查看 `switchBranch` | 重建后对新视图重算；被查看分支视作已展开 |
| 全部展开后 | 痕迹行消失，回到全量布局（x 不变，行数恢复） |
| 阈值 = 不收拢 | `dead` 恒空，面板新分组隐藏，一切如旧 |
| edge 路由 | 路由合法性按当前 lanes 现算，行数变少自动适配，无需专门处理 |

## 6. 测试与验收

- **纯逻辑单测（新增 vitest）**：前端目前无测试基建（AGENTS.md 明言），本
  设计的判定管线与显示变换是逻辑量大头且为纯 TS 函数，Rust 侧无对应物——
  引入 `vitest`（devDependency + `npm test` script）是本设计的**新增基建**，
  范围刻意收窄到 `inactive.ts`。覆盖：merged/dormant 归类、阈值边界（恰好
  90 天）、保护名单、fork 闭包（多级链）、tag 伪 lane 排除、expandedDead
  排除、无 commit 泳道跳过、`lane_index` 紧凑无洞、y 与 lane 一致、隐藏
  commit y 指向痕迹行、traceBars 取变换前 span。
- **端到端**：mock.html + playwright 既有流程，mock 数据补「多死泳道」
  场景（`dump_json` 再生 + 手工补分支，验证完恢复）。
- **验收演示**：shell 脚本生成 1000+ 分支合成仓库（多数已合并/休眠、少数
  活跃 + env 名单命中 + 堆积的 release/*），打开默认泳道数 ≤ 30、痕迹行
  可见、展开/收拢/搜索跳转全链路可用。taskon-server（37 泳道）真实冒烟。
- 后端零改动 → `cargo test` 面不变（tour_repo 两失败为已知 fixture 问题）。

## 7. 明确不做（本 arc 范围外）

- 展开状态跨会话持久化（M2.4 关注集持久化统一做）
- 名单通配匹配（`release/*` 等）与第二档时间上限
- 后端打标（tip_ts / archived 字段）——演进位
- 痕迹行的 hover 明细弹层（首版只做 chip 计数 + 点击展开）

## 8. 风险与注意点

- **变换的完整性是纪律问题**：任何绕过 `collapseLanes` 直接读原
  `lane_index`/`y` 的新渲染点都会错位。Timeline 的 props 从 `GitData` 换成
  变换产物是强制收口。
- 浅拷贝粒度：commits/branches 数组逐项浅拷贝（改 `lane_index`/`y`），
  嵌套字段（branch_refs 等）共享引用，不可 mutate。
- `LANE_HEIGHT` 前后端各有一份（前端 80）——本设计不动它，仅提示存在
  这对孪生常量。
