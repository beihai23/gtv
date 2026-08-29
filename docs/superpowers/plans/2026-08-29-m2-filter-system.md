# M2 过滤系统补完 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「只看我现在关心的东西」成为一等能力：右键泳道只看血缘闭包（2.1）、顶栏日期范围下拉（2.2）、一键隐藏 origin/* badge（2.3）、分支选择按仓库持久化恢复（2.4）。

**Architecture:** 四项**全部前端改动，Rust 后端零改动**。分支选择集 `selectedBranches` 是唯一事实源：2.1 产出选择集（新纯函数 `src/related.ts` → 既有 `filter_by_branches` 重建），2.4 持久化选择集（localStorage 按仓库路径），2.2/2.3 是选择集之上的显示层变换（`src/daterange.ts` 过滤+x 裁剪 + `src/refs.ts` badge 过滤）。

**Tech Stack:** React 19 + TS strict（App/Timeline/CommitDetails 接线）、vitest（四个纯函数模块）、mock.html + 浏览器（E2E）。

**Spec:** `docs/superpowers/specs/2026-08-29-m2-filter-system-design.md`（冲突时以 spec 为准；本计划细化两处 UI 落位：日期下拉与 Remotes 开关都放 header-right 的 view-toggles 行——spec 写"locate 旁/tags 旁"，实际 locate 是 Cmd+F 浮层非常驻、tags 开关在分支面板头部，view-toggles 行才是一键显示开关的家）

## Global Constraints

- **只读红线 + 零后端改动**：本 arc 不碰 src-tauri/ 下任何文件（含 mock 数据契约）。
- TypeScript strict + noUnusedLocals/noUnusedParameters 门禁：每任务完成时 `npm run build` 必过；`npm test` 保持全绿（当前 28 用例：inactive 20 + locate 8）。
- i18n：en/zh 两侧字典同步加键；代码注释/commit message 英文（ASCII 标点）；docs/ 下中文。
- M1.2 组合顺序铁律：`gitData → applyDateRange → computeInactive(过滤后) → dead 并集 → collapseLanes`，先裁剪后收拢；收拢变换自身永不改 x。
- App.tsx 的 TDZ 地雷（M1.3 记录）：新 memo/useCallback 的依赖必须声明在前；插位置先看依赖声明顺序。
- E2E 用 mock.html，dev server 起 **1421** 端口（先探测，用户自己的 1420 不碰）。
- 浏览器驱动用 gstack browse CLI（`$HOME/.claude/skills/gstack/browse/dist/browse`）：输入框用 `fill` 不是 `type`；导航是 `goto`；双击用 `js` dispatchEvent。
- 每个任务 commit trailer 一块：`Backstory: docs/work-backstory/filter-system-m2.md` 紧贴 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（无空行），Co-Authored-By 最后。backstory arc 文件在 Task 1 提交时一并建立（frontmatter：arc/filter-system-m2、started/<当前 HEAD>、status/in-progress、commits/[]）。
- 测试断言里的计数（命中数、集合大小）写 fixture 时**重数一遍**再落（M1.3 教训）。

---

### Task 1: 纯函数 `src/related.ts`（血缘闭包，TDD）

**Files:**
- Create: `src/related.ts`
- Create: `src/related.test.ts`
- Create: `docs/work-backstory/filter-system-m2.md`（arc 启动文件）

**Interfaces:**
- Consumes: `GitData`（`src/types.ts`）。`BranchLane.fork_point`/`merged_into` 是 commit oid；oid → lane_owner 映射从 `data.commits` 的 `lane`/`lane_owner` 建（用 lane_index → name 的反查表，照 `src/inactive.ts` 的 laneByIndex 模式）。
- Produces（Task 4 依赖）:

```ts
/** Lane blood-line closure (spec §4.1): target + fork up-chain (single
 *  line, no siblings) + fork descendants (branching down) + one-hop
 *  mergeTarget of every lane in that set + main_branch always. */
export function relatedLanes(data: GitData, target: string): Set<string>;
```

**实现要点：**
- `forkParent(L)`：L.fork_point oid → 所属 lane 的 name；oid 不在已加载 commits → 无父（上链截断，main 兜底）。
- `mergeTarget(L)`：L.merged_into oid → 所属 lane 的 name，同样可能不可解析。
- 上链迭代、子孙 BFS 反向 fork 边、merge 对象单跳；只考虑非 tag 泳道（`!b.is_tag`，照 computeInactive）。
- target 不在 branches 里 → 返回只含 main_branch 的集合（防御）。

**测试用例（vitest，手搓 GitData fixture）：**
1. 上链单线：main ← A ← B（B.fork_point 在 A 上，A.fork_point 在 main 上），`relatedLanes(data,'B')` = {B, A, main}。
2. **兄弟排除**：C 也 fork 自 A → 不在 `relatedLanes(data,'B')` 里。
3. 子孙：D fork 自 B → `relatedLanes(data,'B')` 含 D；E fork 自 D 也含（BFS 传递）。
4. merge 对象单跳：D merged into release（D.merged_into 指向 release 泳道上的 commit）→ `relatedLanes(data,'B')` 含 release；release 自己的 mergeTarget（若有）**不**传递并入。
5. 反向 merge（被并入 target 的分支）：X.merged_into 指向 B 上的 commit → `relatedLanes(data,'B')` **含 X**（X 的 tip 在 B 的历史里，是 B 的血缘）。
6. main 兜底：B.fork_point 指向不在 commits 里的 oid → 上链断，但 main 始终在集合。
7. 幂等：把 fixture 裁剪到 `relatedLanes(data,'B')` 的分支子集后再算一次 → 同一集合。

**验收：** `npm test` 全绿（28 + related 用例数）；`npm run build` 过。

---

### Task 2: 纯函数 `src/daterange.ts`（日期窗口 + 空泳道沉底，TDD）

**Files:**
- Create: `src/daterange.ts`
- Create: `src/daterange.test.ts`

**Interfaces:**
- Consumes: `GitData`、`DeadKind`（`src/inactive.ts` 导出）。
- Produces（Task 5 依赖）:

```ts
export type DateRange =
  | { kind: 'all' }
  | { kind: 'preset'; days: number }
  | { kind: 'custom'; start: number; end: number }; // epoch 秒，闭区间

/** Display transform (spec §4.2). 'all' returns the SAME reference.
 *  Otherwise: commits filtered to the window, x shifted so the leftmost
 *  visible commit sits at 0 (pure shift, density unchanged), time_gaps
 *  clipped+shifted (empty ones dropped), edges kept iff both endpoints
 *  survive. has_more/branches untouched. */
export function applyDateRange(data: GitData, range: DateRange): GitData;

/** Non-tag lanes with ZERO commits in (already filtered) data -> dead map
 *  (merged_into ? 'archived' : 'dormant'), for union with computeInactive. */
export function emptyLaneDead(data: GitData): Map<string, DeadKind>;

/** Commit ids outside the window — App feeds these into hidden-set unions
 *  (arrow-key stepping) and in_view overrides (locate). Empty for 'all'. */
export function outOfRangeIds(data: GitData, range: DateRange): Set<string>;
```

**实现要点：**
- preset 锚点 = **已加载提交的最大 timestamp**（仓库本地"现在"），窗口 [anchor − days·86400, anchor]，闭区间。
- x 平移基准 = 可见提交的 minX；gap 裁剪到 [minX, maxX] 后同样平移，宽度为 0 的丢弃。
- custom start > end → 空窗口（防御，UI 层另有约束）。
- 三函数共享一次窗口/可见集计算可拆内部 helper，公共 API 保持三个纯函数。

**测试用例：**
1. `all` → `toBe(data)` 同一引用。
2. preset：手搓 ts {100..900} 的提交，days 窗口锚定 max ts，窗口外提交被滤。
3. custom 闭区间：start/end 恰好压在提交 ts 上 → 两个端点提交都保留。
4. x 平移：滤后 minX === 0，任意两提交 x 差值不变。
5. gap：一个横跨窗口左界的 gap 被裁剪+平移；完全在窗口外的 gap 丢弃；无 gap 数据不受影响。
6. edges：双端可见才保留；单端出窗的边丢弃。
7. `emptyLaneDead`：有 merged_into 的空泳道 → archived，无 → dormant；窗口内有提交的泳道不在 map；tag 泳道不在 map。
8. `outOfRangeIds`：all → 空集；preset → 恰为被滤提交的 id 集。

**验收：** `npm test` 全绿；`npm run build` 过。

---

### Task 3: 纯函数 `src/refs.ts` + `src/persist.ts` + 设置项（TDD）

**Files:**
- Create: `src/refs.ts`、`src/refs.test.ts`
- Create: `src/persist.ts`、`src/persist.test.ts`
- Modify: `src/settings.tsx`（hideRemotes 状态，照 showStaleBranches 模式：`gtv_hide_remotes`，默认 false）

**Interfaces:**

```ts
// src/refs.ts
/** Hide remote-tracking refs (origin/*) from badge/tooltip/detail layers;
 *  lane labels use short names and are unaffected (spec §4.3). */
export function filterRefs(refs: BranchRef[], hideRemotes: boolean): BranchRef[];

// src/persist.ts
const key = (repoPath: string) => `gtv_branch_sel:${repoPath}`;
export function saveSelection(repoPath: string, names: string[]): void;
/** Saved ∩ available; null when empty or the FULL set (default state,
 *  no restore rebuild). */
export function restoreSelection(saved: string[] | null, available: string[]): string[] | null;
export function loadSelection(repoPath: string): string[] | null;
```

**实现要点：**
- `filterRefs`：`hideRemotes ? refs.filter(r => !r.is_remote) : refs`。
- `restoreSelection`：JSON 解析失败/非数组 → null（localStorage 脏数据防御，测试要覆盖）。
- settings：SettingsCtx 加 `hideRemotes` + `setHideRemotes`，localStorage 读写照 `setShowStaleBranches`。

**测试用例：** filterRefs 混合列表两种模式各一；restoreSelection 的交集/空→null/全集→null/脏数据→null 共 4-5 例。

**验收：** `npm test` 全绿；`npm run build` 过。

---

### Task 4: 接线 2.1 + 2.3（右键菜单第四项 + badge 五处过滤）

**Files:**
- Modify: `src/components/Timeline.tsx`（lane-menu 加菜单项；画布 badge + tooltip 过滤）
- Modify: `src/App.tsx`（onRelatedBranch handler + 传递；CommitDetails 传 hideRemotes）
- Modify: `src/components/CommitDetails.tsx`（chips 过滤）
- Modify: `src/locate.ts`（matchLoaded 加可选参 `hideRemotes = false`，refTarget 构建跳过 is_remote ref）
- Modify: `src/settings.tsx`（i18n 键：relatedOnly / remotes / remotesTip）
- Modify: `src/locate.test.ts`（现有用例补默认参调用不破；加一例 is_remote ref 不命中）

**接线点（勘察确认）：**
- Timeline lane-menu 现有三项（`src/components/Timeline.tsx:1289-1305`），第四项：

```tsx
<button onClick={() => { onRelatedBranch(laneMenu.lane.name); setLaneMenu(null); }}>
  {t('relatedOnly')}
</button>
```

props 加 `onRelatedBranch: (name: string) => void`。t 从哪来：Timeline 已用 `t('focusLane')`（useSettings 在组件内）。
- App handler：

```ts
const handleRelatedBranch = useCallback((name: string) => {
  if (!gitData) return;
  handleFilterChange([...relatedLanes(gitData, name)]);
}, [gitData, handleFilterChange]);
```

**闭包算自原始 gitData**（非显示层副本——view 的 lane_index 已被收拢重写，name 不变但结构要全量窗口）。
- badge 过滤五处（spec §4.3）：Timeline 画布 badge（`:774` 起，`filterRefs(c.branch_refs, hideRemotes)` 后再 `slice(0, 2)`，`<title>` 与 extra 计数都基于过滤后列表——幽灵计数是 review 重点）；tooltip（`:1322`）；CommitDetails（`:81`）；matchLoaded（refTarget 循环跳过 is_remote，本地 lane 名命中不受影响）；refActivity 不动。
- Timeline/CommitDetails 的 hideRemotes 从 `useSettings()` 取（两组件已各自 useSettings，不必穿 props）。
- Remotes 开关按钮：App header-right 的 view-toggles 行（`:651-685`，Fit 按钮后）：

```tsx
<button className={`view-btn ${hideRemotes ? 'active' : ''}`}
        onClick={() => setHideRemotes(!hideRemotes)} title={t('remotesTip')}>
  {t('remotes')}
</button>
```

**i18n：** relatedOnly: 'Only related branches' / '只显示相关分支'；remotes: 'Remotes' / '远程'；remotesTip: 'Show/hide origin/* remote badges (lane labels stay)' / '显示/隐藏 origin/* 远程 badge（泳道标签不受影响）'。

**验收：** `npm run build` 过、`npm test` 全绿；手验可在 mock（1421）右键泳道看菜单项出现。

---

### Task 5: 接线 2.2 + 2.4（日期管道 + 持久化恢复）

**Files:**
- Modify: `src/App.tsx`（管道重排 + 下拉 UI + 保存/恢复 effect）
- Modify: `src/settings.tsx`（i18n 键：dateAll/dateWeek/dateMonth/date3m/dateYear/dateCustom/dateFrom/dateTo）

**管道重排（现 `:105-112` 的 inactive/view memo）：**

```ts
const [dateRange, setDateRange] = useState<DateRange>({ kind: 'all' });
const rangedData = useMemo(() => gitData ? applyDateRange(gitData, dateRange) : null,
  [gitData, dateRange]);
const rangeDead = useMemo(() => rangedData ? emptyLaneDead(rangedData) : new Map(),
  [rangedData]);
const inactive = useMemo(
  () => rangedData ? computeInactive(rangedData, inactiveDays, expandedDead) : null,
  [rangedData, inactiveDays, expandedDead]);
// Union AFTER computeInactive: range-empty wins over the freshness rule.
const dead = useMemo(() => {
  const m = new Map(inactive?.dead ?? []);
  for (const [k, v] of rangeDead) m.set(k, v);
  return m;
}, [inactive, rangeDead]);
const view = useMemo(() => rangedData ? collapseLanes(rangedData, dead) : null,
  [rangedData, dead]);
const outOfRange = useMemo(() => gitData ? outOfRangeIds(gitData, dateRange) : NO_IDS,
  [gitData, dateRange]);
```

**注意 TDZ**：dateRange state 声明在顶部 state 区；这组 memo 替换原 inactive/view 两块的位置，依赖都在前面。

**下游同步改（勘察确认的消费点）：**
- **ArrowLeft/Right 步进**（`:516-539`）：`hiddenIds` 过滤改用 `hiddenIds ∪ outOfRange`（Stepping into an out-of-range commit would focus empty space——M1.2 注释同理）。
- **locate**：`matchLoaded(rangedData?.commits ?? [], ...)`（搜你所见）+ 远端命中 in_view 修正：`remoteHits.map(h => ({...h, in_view: h.in_view && !outOfRange.has(h.id)}))` 后再进 mergeLocate——范围外命中走既有"从该提交查看"跳转路径，零新 UX。
- **header commitCount**（`:621`）：`rangedData.commits.length`（范围开着时显示可见数，`{n}+ commits` 语义不变）。
- refActivity/sortedBranches（面板排序）继续用原始 gitData——全量活跃度排序对面板更诚实。
- handleLocate 的死泳道自动展开读 `inactive`——现在基于 rangedData，语义自然正确（可见泳道才展开）。

**下拉 UI**（view-toggles 行，Remotes 按钮旁）：native `<select className="view-btn date-select">`，options：全部/本周/本月/近3月/近1年/自定义（value: all/7/30/90/365/custom）；选 custom 时 select 后出现两个 `<input type="date">`（class view-btn，dateFrom/dateTo 占位），变更即 `setDateRange({kind:'custom', start, end})`（Date → epoch 秒，`new Date(v).getTime()/1000`，空值兜底 0/∞）。切换任何选项 `setViewResetKey(k=>k+1)` 重置视口。**dateRange 是会话态不持久化**；打开新仓库时 `setDateRange({kind:'all'})` 复位（两个 open handler 各加一行）。

**2.4 持久化：**
- 保存 effect：

```ts
useEffect(() => {
  if (!latestRepo || selectedBranches.length === 0) return;
  saveSelection(latestRepo, selectedBranches);
}, [latestRepo, selectedBranches]);
```

- 恢复：两个 open handler 里 `setSelectedBranches(branches.map(b => b.name))` 之后插入：

```ts
const saved = loadSelection(path); // path = 本次打开的仓库路径（handleOpenRepo 里 getCurrentPath 已取；handleOpenLatestRepo 里即 latestRepo）
const restored = restoreSelection(saved, branches.map(b => b.name));
if (restored) handleFilterChange(restored); // 子集重建；null → 默认全选不动
```

handleOpenLatestRepo 依赖数组相应加 handleFilterChange。

**i18n：** dateAll 'All time'/'全部'；dateWeek 'Last week'/'本周'；dateMonth 'This month'/'本月'；date3m 'Last 3 months'/'近3月'；dateYear 'Last year'/'近1年'；dateCustom 'Custom'/'自定义'；dateFrom 'From'/'起'；dateTo 'To'/'止'。

**验收：** `npm run build` 过、`npm test` 全绿。

---

### Task 6: mock 增强 + E2E 全量验收

**Files:**
- Modify: `mock.html`（两处，均带诚实注释）

**mock 增强：**
1. `filter_by_branches` 现返回全量 DATA——按 lane_owner 过滤 commits/branches、双端可见过滤 edges（契约的近似 mock：不重算 lane 结构，够 E2E 看泳道收缩/恢复）。
2. 加载时给前 3 条泳道的 tip 提交注入 `origin/<name>` 的 is_remote:true 副本 ref（fixture 无 remote ref，2.3 验收需要）：

```js
for (const name of DATA.branches.slice(0, 3).map(b => b.name)) { /* find lane tip, push {name:'origin/'+name, is_remote:true, is_tag:false, color:''} */ }
```

**E2E（1421 端口，browse CLI；fixture 现状：1477 commits / 976 branches，ts 跨 2025-07-24 → 2026-08-28）：**
- **2.1**：打开 → 右键一条 feature 泳道 → 菜单第四项「只显示相关分支」→ 泳道行数收缩（js 读 canvas lane 数或 header chip 数）、面板 Disabled 组出现 → All → 复原。
- **2.2**：下拉切「本月」→ header 提交数下降（1477 → 数百级）、时间轴范围收缩、范围外泳道沉入痕迹行（Archived/Dormant 计数出现）→ 切「全部」复原。自定义起止再验一轮。
- **2.3**：确认注入的 origin/* badge 可见 → 点 Remotes 开关 → 画布与 tooltip 无 origin/*（js 扫 svg text）→ 详情面板同步 → 再点还原。
- **2.4**：勾掉若干分支（小选择集）→ 刷新页面重开 → header chips 自动恢复小选择集（localStorage 路径键 /mock/taskon-server 稳定）→ All → 刷新 → 全选态（无二次重建闪动）。
- 全程 console 无错误。

**验收：** 四项各留一条 browse 断言记录（js 表达式 + 返回值）写入任务报告。

---

### Task 7: 终审 + 修复波 + 文档收尾

**Files:**
- Read/Modify: 全分支 diff（`.superpowers/sdd/review-<range>.diff`）
- Modify: `docs/roadmap.md`（M2 四项移入"已完成的地基"）
- Modify: `AGENTS.md`（前端测试清单补 related/daterange/refs/persist 与用例总数）
- Modify: `docs/work-backstory/filter-system-m2.md`（arc 收口：commits 全列、Process/Decisions/Lessons 中文、status/resolved）

**步骤：**
1. `git diff main..<branch>`（或本 arc 起点-range）出全量 diff，交终审 subagent（opus）按 spec 逐项核：Critical（错/崩/红线）→ Important（spec 偏离/幽灵计数/组合顺序）→ Minor（记录不阻塞）。
2. 修复波：Critical/Important 清零后逐项修 + 回归 `npm run build` + `npm test`。
3. roadmap/backstory/AGENTS.md 收尾；backstory 记录终审结论与修复波。
4. （用户手动项，不阻塞）真实仓库 GUI 冲烟清单写入任务报告：2.1 右键血缘、2.2 真仓库日期、2.3 真 origin badge、2.4 重开恢复。

---

## 风险提示（实现者注意）

- **App.tsx 是重灾区**（M1.2/M1.3 连续大改）：Task 4/5 都动它，按任务顺序串行执行；每次接线后先 tsc 再手动检查 memo 依赖声明顺序（TDZ）。
- **幽灵计数**（spec §8）：badge 的 slice(0,2)/extra/`<title>` 必须全部基于 filterRefs 之后 的列表——终审盯。
- **组合顺序**：先裁剪后收拢是铁律；collapseLanes 拿到的必须是 applyDateRange 的产物。
- **restoreSelection 的"全集→null"**：分支名含 tag 泳道时（branchList 含 tags），全集判定按 available 原样比较，不区分 tag——与现有 All 按钮行为一致（`handleFilterChange(branchList.map(b => b.name))`）。
- **mock 的 filter_by_branches 近似**会在 E2E 报告里注明"不重算 lane 结构"，避免未来误当真后端语义。
