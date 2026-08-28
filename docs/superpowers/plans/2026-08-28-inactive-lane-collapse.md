# M1.2 非活跃泳道收拢 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 大仓库打开后，已合并/长期无活动的死泳道默认收拢进两条「痕迹行」（只画 bar 不画节点），活跃泳道数 ≤ 30；面板分组与痕迹行点击可展开；x 坐标永不变。

**Architecture:** 纯前端渲染层收拢（spec 方案 A，零后端改动）。新模块 `src/inactive.ts` 两个纯函数：`computeInactive`（判定死泳道）+ `collapseLanes`（把 `lane_index`/`y` 重写为紧凑行的显示副本）。App 用 useMemo 串起来喂给 Timeline；Timeline 加 4 个新 prop（默认空值时行为与现在完全一致）。

**Tech Stack:** React 19 + TypeScript (strict) + D3 v7；新增 vitest 做纯函数单测（前端首个测试基建，范围仅 inactive.ts）。

**Spec:** `docs/superpowers/specs/2026-08-28-inactive-lane-collapse-design.md`（含全部需求决策记录，冲突时以 spec 为准）

## Global Constraints

- 只读红线：不新增任何修改仓库的后端命令。本计划后端零改动。
- IPC 契约（models.rs ↔ types.ts）不动：不加字段、不改命令。
- TypeScript strict + noUnusedLocals/noUnusedParameters 是门禁：每个任务完成时 `npm run build` 必须过。
- 前端持久化 key 前缀 `gtv_`；新 key：`gtv_inactive_days`（默认 90，0 = 不收拢）。
- 保护名单（确名，无通配）：`main master dev develop test testing uat staging sit qa prod production integration release hotfix`。
- `LANE_HEIGHT = 80`：从 Timeline.tsx 挪到 inactive.ts 导出，Timeline 改 import（前端单一来源；后端 layout.rs 有自己的副本，本计划不碰）。
- i18n：settings.tsx 的 en/zh 两个字典都要加词条；zh 的 stale 标签改名「显示窗口外分支」。
- 每个任务的 commit message 末尾带 `Backstory: docs/work-backstory/inactive-lane-collapse.md`。
- 代码注释和 commit message 用英文（AGENTS.md 约定）；设计文档/docs 下中文。

---

### Task 1: vitest 基建

**Files:**
- Modify: `package.json`（devDependencies + scripts）
- Create: `src/smoke.test.ts`（Task 2 会重写为真正的测试文件，这里只验证 runner）

**Interfaces:**
- Produces: `npm test` 命令（= `vitest run`），后续所有前端测试任务用它。

- [ ] **Step 1: 安装 vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: 加 test script**

`package.json` 的 `scripts` 加一行（放在 `"preview"` 之后）：

```json
    "test": "vitest run",
```

- [ ] **Step 3: 写 smoke 测试**

`src/smoke.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';

describe('vitest infra', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

（显式 import 而非 globals，`tsc` 无需额外 types 配置。）

- [ ] **Step 4: 验证测试跑通**

Run: `npm test`
Expected: `1 passed`。

- [ ] **Step 5: 验证 tsc 门禁不受影响**

Run: `npm run build`
Expected: 编译通过（test 文件不在入口依赖图里，vite 不会打包它）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/smoke.test.ts
git commit -m "build: add vitest for frontend pure-function tests

Frontend had no test setup (all automated testing lived in Rust); the
inactive-lane collapse arc needs unit tests for its pure TS pipeline.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `computeInactive` 判定管线（TDD）

**Files:**
- Create: `src/inactive.ts`
- Create: `src/inactive.test.ts`（删除 `src/smoke.test.ts`，其使命已完成）

**Interfaces:**
- Consumes: `GitData`/`BranchLane`/`CommitNode` from `./types`（已存在，勿改）。
- Produces（后续任务依赖的精确签名）:
  - `export type DeadKind = 'archived' | 'dormant';`
  - `export interface InactiveInfo { dead: Map<string, DeadKind>; groups: { archived: BranchLane[]; dormant: BranchLane[] }; }`
  - `export function computeInactive(data: GitData, thresholdDays: number, expandedDead: Set<string>, now?: number): InactiveInfo`
  - `export const LANE_HEIGHT = 80;`
  - 测试夹具 builders `lane()` / `commit()`（测试文件内定义，Task 3 复用方式：从 inactive.test.ts 导出——见 Step 1 的 export）。

- [ ] **Step 1: 写失败测试（含夹具 builders + 全部场景）**

`src/inactive.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { computeInactive, LANE_HEIGHT } from './inactive';
import type { BranchLane, CommitNode, GitData } from './types';

// --- fixtures -------------------------------------------------------------

export function lane(name: string, index: number, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: index, color: '#123456', is_tag: false,
    fork_point: null, merged_into: null, is_active: true, ...over,
  };
}

export function commit(id: string, over: Partial<CommitNode> = {}): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: '', is_head: false, is_key: true,
    additions: 0, deletions: 0, x: 0, y: 0, lane: 0, ...over,
  };
}

const NOW = 1_000_000_000;
const d = (days: number) => NOW - days * 86400;

function gitData(commits: CommitNode[], branches: BranchLane[]): GitData {
  return {
    commits, edges: [], branches, main_branch: 'main', time_gaps: [],
    has_more: false,
  };
}

// --- tests ----------------------------------------------------------------

describe('computeInactive', () => {
  it('threshold 0 disables collapsing entirely', () => {
    const info = computeInactive(gitData([], [lane('x', 0)]), 0, new Set(), NOW);
    expect(info.dead.size).toBe(0);
    expect(info.groups.archived).toHaveLength(0);
    expect(info.groups.dormant).toHaveLength(0);
  });

  it('merged + quiet lane is archived; unmerged + quiet is dormant', () => {
    const data = gitData(
      [
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) }),
        commit('a1', { lane: 1, lane_owner: 'oldfeat', timestamp: d(200) }),
        commit('u1', { lane: 2, lane_owner: 'wip', timestamp: d(200) }),
      ],
      [
        lane('main', 0),
        lane('oldfeat', 1, { merged_into: 'm1' }),
        lane('wip', 2),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('oldfeat')).toBe('archived');
    expect(info.dead.get('wip')).toBe('dormant');
    expect(info.groups.archived.map(l => l.name)).toEqual(['oldfeat']);
    expect(info.groups.dormant.map(l => l.name)).toEqual(['wip']);
  });

  it('fresh lanes stay regardless of merge state', () => {
    const data = gitData(
      [
        commit('a1', { lane: 1, lane_owner: 'recentfeat', timestamp: d(10), }),
      ],
      [lane('recentfeat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('recentfeat')).toBe(false);
  });

  it('boundary: tip exactly at the cutoff stays active', () => {
    const data = gitData(
      [commit('a1', { lane: 1, lane_owner: 'edge', timestamp: d(90) })],
      [lane('edge', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('edge')).toBe(false);
  });

  it('protected exact names never collapse (even quiet and merged)', () => {
    const data = gitData(
      [commit('u1', { lane: 1, lane_owner: 'uat', timestamp: d(500) })],
      [lane('uat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('uat')).toBe(false);
  });

  it('protection is exact-name: feature/dev is NOT dev', () => {
    const data = gitData(
      [commit('f1', { lane: 1, lane_owner: 'feature/dev', timestamp: d(500) })],
      [lane('feature/dev', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('feature/dev')).toBe('archived');
  });

  it('fork-parent closure keeps ancestors of active lanes', () => {
    // active feature forked from old release/v1 → v1 is load-bearing
    const data = gitData(
      [
        commit('r1', { id: 'r1', lane: 1, lane_owner: 'release/v1', timestamp: d(400), x: 10 }),
        commit('f1', { lane: 2, lane_owner: 'feat', timestamp: d(5), parents: ['r1'] }),
      ],
      [
        lane('release/v1', 1, { fork_point: 'root' }),
        lane('feat', 2, { fork_point: 'r1' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('feat')).toBe(false);
    expect(info.dead.has('release/v1')).toBe(false);
  });

  it('closure walks through already-active parents (grandparent kept)', () => {
    // feat(active) → forked from dev(active) → forked from base(quiet, merged)
    const data = gitData(
      [
        commit('b1', { lane: 1, lane_owner: 'base', timestamp: d(400), x: 10 }),
        commit('d1', { lane: 2, lane_owner: 'dev', timestamp: d(20), x: 20 }),
        commit('f1', { lane: 3, lane_owner: 'feat', timestamp: d(5), x: 30 }),
      ],
      [
        lane('base', 1, { merged_into: 'm0', fork_point: 'root' }),
        lane('dev', 2, { fork_point: 'b1' }),
        lane('feat', 3, { fork_point: 'd1' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('base')).toBe(false);
  });

  it('dead lanes with dead dependents still collapse (no live descendant)', () => {
    // dead2 forked from dead1, both quiet → both dead
    const data = gitData(
      [
        commit('d1c', { lane: 1, lane_owner: 'dead1', timestamp: d(400), x: 10 }),
        commit('d2c', { lane: 2, lane_owner: 'dead2', timestamp: d(300), x: 20 }),
      ],
      [
        lane('dead1', 1, { merged_into: 'm0' }),
        lane('dead2', 2, { fork_point: 'd1c' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('dead1')).toBe('archived');
    expect(info.dead.get('dead2')).toBe('dormant');
  });

  it('tag pseudo-lanes never take part', () => {
    const data = gitData(
      [commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) })],
      [lane('v1.0', 5, { is_tag: true })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('v1.0')).toBe(false);
  });

  it('lanes with no loaded commits are skipped (not dead, not grouped)', () => {
    const data = gitData(
      [commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) })],
      [lane('main', 0), lane('ghost', 3, { merged_into: 'm1' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('ghost')).toBe(false);
    expect(info.groups.archived).toHaveLength(0);
  });

  it('expandedDead lanes are excluded from dead but stay in groups', () => {
    const data = gitData(
      [commit('a1', { lane: 1, lane_owner: 'oldfeat', timestamp: d(200) })],
      [lane('oldfeat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(['oldfeat']), NOW);
    expect(info.dead.has('oldfeat')).toBe(false);
    expect(info.groups.archived.map(l => l.name)).toEqual(['oldfeat']);
  });

  it('lane with no own commits falls back to its ref target timestamp', () => {
    // release/v1.x-style lanes: the ref sits on a commit owned by another
    // lane, so the lane itself has zero loaded commits. Without the ref
    // fallback these escape collapsing (and defeat the acceptance fixture).
    const data = gitData(
      [
        commit('m0', {
          lane: 0, lane_owner: 'main', timestamp: d(300), x: 10,
          branch_refs: [{ name: 'old-rel', is_remote: false, is_tag: false, color: '#000' }],
        }),
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1), x: 20 }),
      ],
      [lane('main', 0), lane('old-rel', 1, { merged_into: 'm1' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('old-rel')).toBe('archived');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module './inactive'`（或等价的模块不存在错误）。

- [ ] **Step 3: 实现 `src/inactive.ts`**

```typescript
import type { BranchLane, GitData } from './types';

// ---------------------------------------------------------------------------
// Inactive-lane collapsing (roadmap M1.2). Pure frontend display state: the
// backend view is never re-filtered for this, x coordinates never move.
// ---------------------------------------------------------------------------

/** One rendered lane row is this many px tall (must match src-tauri layout). */
export const LANE_HEIGHT = 80;

export type DeadKind = 'archived' | 'dormant';

export interface InactiveInfo {
  /** Collapsed lanes only (user-expanded ones excluded); lane name -> group. */
  dead: Map<string, DeadKind>;
  /** Panel listing groups, INCLUDING user-expanded lanes (shown checked). */
  groups: { archived: BranchLane[]; dormant: BranchLane[] };
}

/** Protected exact short names — a bounded set (~1 lane each per repo).
 *  Deliberately NO wildcards: release/* and hotfix/* accumulate unbounded on
 *  teams that never clean them, and name-protecting them would defeat the
 *  ≤30-lane acceptance on exactly those repos. Active ones are protected by
 *  the freshness rule anyway; quiet ones belong in the sediment rows. */
const PROTECTED_NAMES = new Set([
  'main', 'master', 'dev', 'develop', 'test', 'testing', 'uat', 'staging',
  'sit', 'qa', 'prod', 'production', 'integration', 'release', 'hotfix',
]);

export function computeInactive(
  data: GitData,
  thresholdDays: number,
  expandedDead: Set<string>,
  now: number = Math.floor(Date.now() / 1000),
): InactiveInfo {
  const dead = new Map<string, DeadKind>();
  const archived: BranchLane[] = [];
  const dormant: BranchLane[] = [];
  if (thresholdDays <= 0) return { dead, groups: { archived, dormant } };

  const cutoff = now - thresholdDays * 86400;

  // Lane tip = newest loaded commit on the lane. Walk seeds ARE the branch
  // tips, so a real tip is always loaded. Lanes whose ref sits on a commit
  // owned by ANOTHER lane (release/v1.x-style) have no own commits — for
  // those, the ref target's timestamp is the honest "last activity".
  const tipTs = new Map<number, number>();
  for (const c of data.commits) {
    const prev = tipTs.get(c.lane);
    if (prev === undefined || c.timestamp > prev) tipTs.set(c.lane, c.timestamp);
  }
  const refTs = new Map<string, number>();
  for (const c of data.commits) {
    for (const r of c.branch_refs) {
      const prev = refTs.get(r.name);
      if (prev === undefined || c.timestamp > prev) refTs.set(r.name, c.timestamp);
    }
  }
  const laneTip = (b: BranchLane): number | undefined => {
    const own = tipTs.get(b.lane_index);
    const ref = refTs.get(b.name);
    if (own === undefined) return ref;
    if (ref === undefined) return own;
    return Math.max(own, ref);
  };

  const realLanes = data.branches.filter(b => !b.is_tag);
  const laneByName = new Map(realLanes.map(l => [l.name, l]));
  const laneByIndex = new Map(realLanes.map(l => [l.lane_index, l]));
  const laneOfCommit = new Map(data.commits.map(c => [c.id, c.lane]));

  // Fresh or name-protected lanes are kept.
  const keep = new Set<string>();
  for (const b of realLanes) {
    const ts = laneTip(b);
    if ((ts !== undefined && ts >= cutoff) || PROTECTED_NAMES.has(b.name)) {
      keep.add(b.name);
    }
  }

  // Fork-parent closure: walk UP from every kept lane — every ancestor on
  // that chain is load-bearing ("dead" means nothing alive depends on it).
  // Birth relations form a DAG, but the walked-set guards cycles anyway.
  const walked = new Set<string>();
  const stack: string[] = [...keep];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (walked.has(name)) continue;
    walked.add(name);
    const l = laneByName.get(name);
    if (!l?.fork_point) continue;
    const parentIdx = laneOfCommit.get(l.fork_point);
    const parent = parentIdx !== undefined ? laneByIndex.get(parentIdx) : undefined;
    if (!parent) continue;
    keep.add(parent.name);
    stack.push(parent.name);
  }

  // Structural bonus (no extra rule needed): a merge absorbs the child's TIP,
  // so the merge commit on the target lane is at least as fresh as that tip —
  // the target of an active lane's merge can never be dead.

  const classify = (b: BranchLane): DeadKind => (b.merged_into ? 'archived' : 'dormant');
  for (const b of realLanes) {
    if (keep.has(b.name)) continue;
    if (laneTip(b) === undefined) continue; // no loaded commits AND no ref: skip
    if (expandedDead.has(b.name)) continue; // user restored it
    const kind = classify(b);
    dead.set(b.name, kind);
    (kind === 'archived' ? archived : dormant).push(b);
  }
  // Expanded lanes stay listed (checked) in their panel group.
  for (const b of realLanes) {
    if (keep.has(b.name) || !expandedDead.has(b.name)) continue;
    (classify(b) === 'archived' ? archived : dormant).push(b);
  }

  return { dead, groups: { archived, dormant } };
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `npm test`
Expected: 全部 PASS（13 个用例）。

- [ ] **Step 5: tsc 门禁**

Run: `npm run build`
Expected: 通过。同时删除 `src/smoke.test.ts`（`rm src/smoke.test.ts`）。

- [ ] **Step 6: Commit**

```bash
git add src/inactive.ts src/inactive.test.ts package.json
git rm src/smoke.test.ts
git commit -m "feat: inactive-lane classification pipeline (computeInactive)

Pure function: merged/dormant grouping by lane tip age, bounded exact-name
protection list, fork-parent closure over live lanes, tag pseudo-lanes
excluded. Frontend's first unit-tested module (vitest).

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `collapseLanes` 显示变换（TDD）

**Files:**
- Modify: `src/inactive.ts`（追加）
- Modify: `src/inactive.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 2 的 `DeadKind`、`LANE_HEIGHT`、测试夹具。
- Produces:
  - `export interface TraceRow { laneIndex: number; kind: DeadKind; count: number; }`
  - `export interface TraceBar { laneIndex: number; x1: number; x2: number; color: string; }`
  - `export interface CollapsedView { data: GitData; hiddenIds: Set<string>; traceRows: TraceRow[]; traceBars: TraceBar[]; }`
  - `export function collapseLanes(data: GitData, dead: Map<string, DeadKind>): CollapsedView`
  - 语义契约：`dead` 为空时返回原 `data` 引用（对象恒等，避免无谓重绘）；x 坐标永不改。

- [ ] **Step 1: 追加失败测试**

`src/inactive.test.ts` 顶部 import 改为：

```typescript
import { computeInactive, collapseLanes, LANE_HEIGHT } from './inactive';
```

文件末尾追加：

```typescript
describe('collapseLanes', () => {
  const mk = () => gitData(
    [
      commit('m1', { lane: 0, lane_owner: 'main', x: 100, y: 0 }),
      commit('m2', { lane: 0, lane_owner: 'main', x: 200, y: 0 }),
      commit('a1', { lane: 1, lane_owner: 'arch1', x: 150, y: LANE_HEIGHT }),
      commit('a2', { lane: 1, lane_owner: 'arch1', x: 170, y: LANE_HEIGHT }),
      commit('u1', { lane: 2, lane_owner: 'dorm1', x: 180, y: LANE_HEIGHT * 2 }),
      commit('k1', { lane: 3, lane_owner: 'keep1', x: 220, y: LANE_HEIGHT * 3 }),
    ],
    [
      lane('main', 0),
      lane('arch1', 1, { merged_into: 'm2', color: '#aa0000' }),
      lane('dorm1', 2, { color: '#00aa00' }),
      lane('keep1', 3, { color: '#0000aa' }),
    ],
  );

  it('empty dead map returns the original data object', () => {
    const data = mk();
    expect(collapseLanes(data, new Map()).data).toBe(data);
  });

  it('compacts active lanes to hole-free rows, appends two trace rows', () => {
    const dead = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const byName = new Map(v.data.branches.map(b => [b.name, b.lane_index]));
    expect(byName.get('main')).toBe(0);
    expect(byName.get('keep1')).toBe(1); // compacted, no hole
    const rows = v.traceRows.map(r => r.kind);
    expect(rows).toEqual(['archived', 'dormant']);
    expect(v.traceRows[0].laneIndex).toBe(2);
    expect(v.traceRows[1].laneIndex).toBe(3);
    expect(v.traceRows[0].count).toBe(1);
  });

  it('hidden commits retarget to their group trace row; x never changes', () => {
    const dead = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const a1 = v.data.commits.find(c => c.id === 'a1')!;
    const u1 = v.data.commits.find(c => c.id === 'u1')!;
    expect(a1.lane).toBe(2);
    expect(a1.y).toBe(2 * LANE_HEIGHT);
    expect(a1.x).toBe(150);
    expect(u1.lane).toBe(3);
    expect(u1.y).toBe(3 * LANE_HEIGHT);
    expect(v.hiddenIds.has('a1')).toBe(true);
    expect(v.hiddenIds.has('u1')).toBe(true);
    const m1 = v.data.commits.find(c => c.id === 'm1')!;
    expect(v.hiddenIds.has('m1')).toBe(false);
    expect(m1.y).toBe(0);
  });

  it('kept-lane commits get compacted y consistent with their lane row', () => {
    const dead = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const k1 = v.data.commits.find(c => c.id === 'k1')!;
    expect(k1.lane).toBe(1);
    expect(k1.y).toBe(1 * LANE_HEIGHT);
  });

  it('trace bars use PRE-collapse spans and lane colors', () => {
    const dead = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const arch = v.traceBars.find(b => b.laneIndex === 2)!;
    expect(arch.x1).toBe(150);
    expect(arch.x2).toBe(170);
    expect(arch.color).toBe('#aa0000');
    const dorm = v.traceBars.find(b => b.laneIndex === 3)!;
    expect(dorm.x1).toBe(180);
    expect(dorm.x2).toBe(180);
    expect(dorm.color).toBe('#00aa00');
  });

  it('a group with no collapsed lanes gets no trace row', () => {
    const dead = new Map([['arch1', 'archived']]); // nothing dormant
    const v = collapseLanes(mk(), dead);
    expect(v.traceRows.map(r => r.kind)).toEqual(['archived']);
    const u1 = v.data.commits.find(c => c.id === 'u1')!;
    expect(u1.lane).toBe(1); // dorm1 kept, compacted
    expect(v.hiddenIds.has('u1')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `npm test`
Expected: FAIL — `collapseLanes` 不存在。

- [ ] **Step 3: 实现（追加到 `src/inactive.ts`）**

```typescript
export interface TraceRow {
  /** Pseudo-lane row index the group's sediment bars draw on. */
  laneIndex: number;
  kind: DeadKind;
  count: number;
}

export interface TraceBar {
  laneIndex: number;
  x1: number;
  x2: number;
  color: string;
}

export interface CollapsedView {
  /** Display copy: active lanes compacted to rows 0..k-1 (dead lanes removed
   *  from `branches`); hidden commits retargeted to their group's trace row.
   *  x coordinates are NEVER touched. */
  data: GitData;
  /** Commits belonging to collapsed lanes (rendering skips them). */
  hiddenIds: Set<string>;
  traceRows: TraceRow[];
  traceBars: TraceBar[];
}

export function collapseLanes(data: GitData, dead: Map<string, DeadKind>): CollapsedView {
  if (dead.size === 0) {
    return { data, hiddenIds: new Set(), traceRows: [], traceBars: [] };
  }

  const deadIdx = new Set<number>();
  for (const b of data.branches) {
    if (dead.has(b.name)) deadIdx.add(b.lane_index);
  }

  // Row compaction: active lanes keep their relative order; trace rows go
  // below all of them (sediment settles at the bottom).
  const rowOf = new Map<number, number>();
  let row = 0;
  for (const b of data.branches) {
    if (deadIdx.has(b.lane_index)) continue;
    rowOf.set(b.lane_index, row++);
  }
  const traceRowOfKind = new Map<DeadKind, number>();
  const counts: Record<DeadKind, number> = { archived: 0, dormant: 0 };
  for (const kind of dead.values()) counts[kind]++;
  if (counts.archived > 0) traceRowOfKind.set('archived', row++);
  if (counts.dormant > 0) traceRowOfKind.set('dormant', row++);

  // Commits: kept lanes get compacted lane/y; dead-lane commits are hidden
  // and retargeted to the trace row so fit-bounds (min/max over ALL commit
  // y) cannot explode from rows that no longer exist.
  const hiddenIds = new Set<string>();
  const commits = data.commits.map(c => {
    if (!deadIdx.has(c.lane)) {
      const r = rowOf.get(c.lane)!;
      return r === c.lane ? c : { ...c, lane: r, y: r * LANE_HEIGHT };
    }
    hiddenIds.add(c.id);
    const kind = dead.get(c.lane_owner) ?? 'archived';
    const tr = traceRowOfKind.get(kind) ?? row - 1;
    return { ...c, lane: tr, y: tr * LANE_HEIGHT };
  });

  const branches = data.branches
    .filter(b => !deadIdx.has(b.lane_index))
    .map(b => ({ ...b, lane_index: rowOf.get(b.lane_index)! }));

  // Sediment bars: one bar per dead lane, spanning its PRE-collapse commits.
  const traceBars: TraceBar[] = [];
  for (const b of data.branches) {
    const kind = dead.get(b.name);
    if (!kind) continue;
    const tr = traceRowOfKind.get(kind);
    if (tr === undefined) continue;
    let min = Infinity;
    let max = -Infinity;
    for (const c of data.commits) {
      if (c.lane !== b.lane_index) continue;
      if (c.x < min) min = c.x;
      if (c.x > max) max = c.x;
    }
    if (min <= max) traceBars.push({ laneIndex: tr, x1: min, x2: max, color: b.color });
  }

  const traceRows: TraceRow[] = [];
  for (const kind of ['archived', 'dormant'] as const) {
    const laneIndex = traceRowOfKind.get(kind);
    if (laneIndex !== undefined) traceRows.push({ laneIndex, kind, count: counts[kind] });
  }

  return { data: { ...data, commits, branches }, hiddenIds, traceRows, traceBars };
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: tsc 门禁 + Commit**

Run: `npm run build`
Expected: 通过。

```bash
git add src/inactive.ts src/inactive.test.ts
git commit -m "feat: collapseLanes display transform (row compaction + trace rows)

Rewrites lane_index/y into compacted display copies; dead-lane commits are
flagged hidden and retargeted to their sediment row (fit-bounds safety);
trace bars keep pre-collapse spans and lane colors. Original data identity
is returned when nothing is collapsed.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 设置项 `gtv_inactive_days` + i18n + 设置 UI

**Files:**
- Modify: `src/settings.tsx`
- Modify: `src/components/SettingsDialog.tsx`

**Interfaces:**
- Produces: `useSettings()` 新增 `inactiveDays: number`（0 = 不收拢，默认 90）与 `setInactiveDays: (d: number) => void`；i18n 新 key（Task 6 复用）：`archivedLanes`、`dormantLanes`、`expandGroup`。

- [ ] **Step 1: settings.tsx — 加 key 与持久化**

`const STALE_KEY = ...` 之后加：

```typescript
const INACTIVE_DAYS_KEY = 'gtv_inactive_days';
```

en 字典（`showStaleTip` 行后）加：

```typescript
  collapseInactive: 'Collapse inactive lanes',
  collapseInactiveTip: 'Lanes with no activity for this long collapse out of the graph into sediment rows: merged ones under "Archived", never-merged ones under "Dormant". Base branches like main/dev/uat and ancestors of active lanes always stay.',
  inactiveOff: 'Off',
  daysUnit: '{n}d',
  archivedLanes: 'Archived ({n})',
  dormantLanes: 'Dormant ({n})',
  expandGroup: 'Expand',
```

zh 字典（`showStaleTip` 行后）加（注意 `showStale` 同步改名）：

```typescript
  showStale: '显示窗口外分支',
  showStaleTip: '处理并显示 tip 在已加载历史窗口之外的分支。超大仓库可关闭以减少加载量。',
  collapseInactive: '收拢不活跃泳道',
  collapseInactiveTip: '超过该时长无活动的泳道默认收拢出画布，沉入痕迹行：已合并的进「已归档」，未合并的进「休眠」。main/dev/uat 等基座分支和活跃分支的祖先泳道始终保留。',
  inactiveOff: '不收拢',
  daysUnit: '{n} 天',
  archivedLanes: '已归档 ({n})',
  dormantLanes: '休眠 ({n})',
  expandGroup: '展开',
```

（en 字典里原有的 `showStale`/`showStaleTip` 两行保持不动；zh 里是用新文本**替换**那两行。）

`SettingsCtx` 接口加：

```typescript
  /** Lane-inactivity threshold in days; 0 disables collapsing.
   *  Persisted as gtv_inactive_days. */
  inactiveDays: number;
  setInactiveDays: (d: number) => void;
```

`SettingsProvider` 里（stale state 之后）加：

```typescript
  const [inactiveDays, setInactiveDaysState] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(INACTIVE_DAYS_KEY) ?? '90', 10);
    return Number.isFinite(v) && v >= 0 ? v : 90;
  });
  const setInactiveDays = (d: number) => {
    localStorage.setItem(INACTIVE_DAYS_KEY, String(d));
    setInactiveDaysState(d);
  };
```

Provider value 改为：

```typescript
      <Ctx.Provider value={{ lang, theme, showStaleBranches, inactiveDays, setLang, setTheme, setShowStaleBranches, setInactiveDays, t }}>{children}</Ctx.Provider>
```

- [ ] **Step 2: SettingsDialog.tsx — 加阈值分段按钮**

解构改为：

```typescript
  const { lang, theme, setLang, setTheme, showStaleBranches, setShowStaleBranches, inactiveDays, setInactiveDays, t } = useSettings();
```

stale toggle 的 `settings-section` 之后加：

```tsx
          <div className="settings-section">
            <div className="settings-section-title" title={t('collapseInactiveTip')}>
              {t('collapseInactive')}
            </div>
            <div className="settings-segmented">
              {[30, 90, 180, 365, 0].map(d => (
                <button
                  key={d}
                  className={inactiveDays === d ? 'active' : ''}
                  onClick={() => setInactiveDays(d)}
                >
                  {d === 0 ? t('inactiveOff') : t('daysUnit', { n: d })}
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 3: 验证**

Run: `npm run build`
Expected: tsc 通过（新 key 两侧字典都加了，无 unused）。

手动冒烟（可选，执行者可用 mock.html + /browse）：打开设置对话框，切阈值档位，localStorage 里 `gtv_inactive_days` 跟随变化。

- [ ] **Step 4: Commit**

```bash
git add src/settings.tsx src/components/SettingsDialog.tsx
git commit -m "feat: inactive-lane threshold setting (gtv_inactive_days, default 90)

Settings-dialog segmented control (30/90/180/365/off). Renames the stale
toggle's zh label to 显示窗口外分支 — the loading-window concept was
masquerading under the name the new activity concept needs.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Timeline 渲染收拢态（新 props + 痕迹行）

**Files:**
- Modify: `src/components/Timeline.tsx`
- Modify: `src/App.css`（`.trace-chip` 样式，见 Step 4）
- Modify: `src/App.tsx`（Step 6 传默认 prop，保持行为不变）

**Interfaces:**
- Consumes: Task 2/3 的 `LANE_HEIGHT`、`TraceRow`、`TraceBar`、`DeadKind`；Task 4 的 i18n key `archivedLanes`/`dormantLanes`。
- Produces: Timeline 新 props（Task 6 传值）：`hiddenIds: Set<string>`、`traceRows: TraceRow[]`、`traceBars: TraceBar[]`、`onExpandTraceGroup: (kind: DeadKind) => void`。**本任务结束时 App 还没传新 props——App.tsx 必须同步加默认值传参（Step 6），保证编译和行为不变。**

- [ ] **Step 1: import 与常量**

Timeline.tsx 顶部加：

```typescript
import { LANE_HEIGHT } from '../inactive';
import type { TraceRow, TraceBar, DeadKind } from '../inactive';
```

删除本地 `const LANE_HEIGHT = 80;`（`MINIMAP_W`/`MINIMAP_H` 保留原地）。

- [ ] **Step 2: props 接口与组件签名**

`TimelineProps` 末尾（`focusCommit` 之后）加：

```typescript
  /** Inactive-lane collapse (frontend display state). Empty values = the
   *  pre-collapse rendering, byte for byte. */
  hiddenIds: Set<string>;
  traceRows: TraceRow[];
  traceBars: TraceBar[];
  /** Trace-row / trace-chip click: expand the whole group. */
  onExpandTraceGroup: (kind: DeadKind) => void;
```

组件解构参数加 `hiddenIds, traceRows, traceBars, onExpandTraceGroup`。

- [ ] **Step 3: 可见性过滤**

`visibleCommits` 改为：

```typescript
  const visibleCommits = useMemo(() => {
    const alive = data.commits.filter(c => !hiddenIds.has(c.id));
    if (!compressed) return alive;
    return alive.filter(c => c.is_key || expandedLanes.has(c.lane_owner));
  }, [data, compressed, expandedLanes, hiddenIds]);
```

`hiddenCountByLane` 的循环条件加 hidden 跳过：

```typescript
    for (const c of data.commits) {
      if (hiddenIds.has(c.id)) continue;
      if (!c.is_key && !expandedLanes.has(c.lane_owner)) {
```

deps 数组补 `hiddenIds`。

- [ ] **Step 4: draw() 内 — 痕迹行渲染（lane-bar 块之后、lane chips 块之前插入）**

```typescript
    // --- inactive-lane sediment rows ----------------------------------------
    // Dead lanes get no rows of their own; their spans draw as thin
    // translucent bars inside one trace row per group (bars only — no
    // nodes, no edges). Overlapping bars darken naturally, so a dense pile
    // of dead history reads as darker sediment. Click expands the group.
    g.selectAll('.trace-bar')
      .data(traceBars)
      .enter()
      .append('line')
      .attr('class', 'trace-bar')
      .attr('x1', (d: TraceBar) => d.x1)
      .attr('x2', (d: TraceBar) => d.x2)
      .attr('y1', (d: TraceBar) => d.laneIndex * LANE_HEIGHT)
      .attr('y2', (d: TraceBar) => d.laneIndex * LANE_HEIGHT)
      .attr('stroke', (d: TraceBar) => d.color)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('opacity', 0.3)
      .attr('pointer-events', 'none');
    const traceLabel = (r: TraceRow) =>
      t(r.kind === 'archived' ? 'archivedLanes' : 'dormantLanes', { n: r.count });
    g.selectAll('.trace-hit')
      .data(traceRows)
      .enter()
      .append('rect')
      .attr('class', 'trace-hit')
      .attr('x', minX - 50)
      .attr('width', maxX + 100 - (minX - 50))
      .attr('y', (d: TraceRow) => d.laneIndex * LANE_HEIGHT - 12)
      .attr('height', 24)
      .attr('fill', 'rgba(0,0,0,0)')
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d: TraceRow) => {
        event.stopPropagation();
        onExpandTraceGroup(d.kind);
      })
      .append('title')
      .text((d: TraceRow) => `${traceLabel(d)} — ${t('expandGroup')}`);
```

rail chips 块之后（`.on('contextmenu', ...)` 的 join 结束处）追加 trace chips（branches join 的 exit 会先清掉上一帧的 trace chip，因为它们的 key 不在 branches 数据里）：

```typescript
    // Trace-row chips ride the same rail; datum is BranchLane-shaped so the
    // shared cull() code path (lane_index-keyed) handles them unchanged.
    rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip.trace-chip')
      .data(traceRows.map(r => ({
        name: traceLabel(r),
        lane_index: r.laneIndex,
        color: '#888888',
        is_tag: false,
        fork_point: null,
        merged_into: null,
        is_active: false,
      })), (d: BranchLane) => d.name)
      .join('div')
      .attr('class', 'lane-chip trace-chip')
      .style('color', (d: BranchLane) => d.color)
      .style('border-color', (d: BranchLane) => d.color)
      .text((d: BranchLane) => d.name)
      .style('cursor', 'pointer')
      .on('click', (_e: MouseEvent, d: BranchLane) => {
        const r = traceRows.find(tr => tr.laneIndex === d.lane_index);
        if (r) onExpandTraceGroup(r.kind);
      });
```

`src/App.css` 追加：

```css
.lane-chip.trace-chip { font-style: italic; opacity: 0.85; }
```

- [ ] **Step 5: cull() 与 minimap**

cull() 里 `.collapse-chip` 块之后追加：

```typescript
      g.selectAll<SVGLineElement, TraceBar>('.trace-bar')
        .style('display', d => (d.x2 >= x0 && d.x1 <= x1 ? null : 'none'));
      g.selectAll<SVGRectElement, TraceRow>('.trace-hit')
        .style('display', d => {
          const y = d.laneIndex * LANE_HEIGHT;
          return y >= y0 && y <= y1 ? null : 'none';
        });
```

minimap 的 dot 循环改（跳过隐藏 commit 的圆点）：

```typescript
      for (const c of data.commits) {
        if (!c.is_key || hiddenIds.has(c.id)) continue;
```

minimap 的 branches 循环之后追加 trace bars（低透明度沉积条）：

```typescript
      for (const tb of traceBars) {
        const y = my(tb.laneIndex * LANE_HEIGHT);
        mm.append('line')
          .attr('x1', mx(tb.x1))
          .attr('x2', Math.max(mx(tb.x2), mx(tb.x1) + 1))
          .attr('y1', y).attr('y2', y)
          .attr('stroke', tb.color)
          .attr('stroke-width', 2)
          .attr('opacity', 0.35);
      }
```

reset 视口的目标选择（`shouldReset` 分支）改为优先可见节点：

```typescript
      const newest = data.commits.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      const head = data.commits.find(c => c.is_head && !hiddenIds.has(c.id));
      const newestVisible = visibleCommits.length > 0
        ? visibleCommits.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
        : null;
      const target = head ?? newestVisible ?? data.commits.find(c => c.is_head) ?? newest;
```

draw 的 useCallback deps 数组追加：`hiddenIds, traceRows, traceBars, onExpandTraceGroup`。

- [ ] **Step 6: App.tsx 传默认值（保持行为不变，编译可过）**

`<Timeline ...>` 加四个 prop：

```tsx
              hiddenIds={new Set<string>()}
              traceRows={[]}
              traceBars={[]}
              onExpandTraceGroup={() => {}}
```

（Task 6 会替换成真实值；这保证本任务独立可验证：一切如旧。）

- [ ] **Step 7: 验证**

Run: `npm run build && npm test`
Expected: 都通过。

浏览器回归（mock.html，执行者用 /browse 或按 backstory 流程）：`npm run dev -- --port 1421`（先 curl 探测 1420/1421 是否被占用，用户自己的 dev server 不要动），打开 `http://localhost:1421/mock.html`，确认图与改造前完全一致（空 props 路径）。

- [ ] **Step 8: Commit**

```bash
git add src/components/Timeline.tsx src/App.css src/App.tsx
git commit -m "feat: timeline renders collapsed inactive lanes as sediment trace rows

hiddenIds filters nodes/edges/+N chips/minimap dots; trace bars draw per
dead lane in two thin rows with full-width click-to-expand hit targets;
trace chips ride the lane rail. Viewport reset prefers visible commits.
Empty props render byte-for-byte as before.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: App 接线 — 状态、面板分组、定位自动展开

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: Task 2/3 的 `computeInactive`/`collapseLanes`/`CollapsedView`/`DeadKind`；Task 4 的 `inactiveDays`/i18n；Task 5 的 Timeline 新 props。
- Produces: 完整用户可见功能。

- [ ] **Step 1: 状态与 memo**

import 区加：

```typescript
import { computeInactive, collapseLanes } from './inactive';
import type { DeadKind } from './inactive';
```

模块级常量（`SHOW_TAGS_KEY` 附近）：

```typescript
const NO_IDS: Set<string> = new Set();
```

组件内（`showStaleBranches` 解构改为也取 `inactiveDays`）：

```typescript
  const { t, showStaleBranches, inactiveDays } = useSettings();
```

state 区（`showPatchLinks` 组之后）：

```typescript
  // Inactive-lane collapse: which dead lanes the user has restored.
  const [expandedDead, setExpandedDead] = useState<Set<string>>(new Set());
```

memo 区（`refActivity` 之前）：

```typescript
  const inactive = useMemo(
    () => (gitData ? computeInactive(gitData, inactiveDays, expandedDead) : null),
    [gitData, inactiveDays, expandedDead],
  );
  const view = useMemo(
    () => (gitData && inactive ? collapseLanes(gitData, inactive.dead) : null),
    [gitData, inactive],
  );
  const hiddenIds = view?.hiddenIds ?? NO_IDS;
  const allDeadNames = useMemo(() => {
    const s = new Set<string>();
    for (const l of inactive?.groups.archived ?? []) s.add(l.name);
    for (const l of inactive?.groups.dormant ?? []) s.add(l.name);
    return s;
  }, [inactive]);
```

- [ ] **Step 2: 展开/收拢 handlers + 重置点**

（`toggleBranchFilter` 之后）

```typescript
  const toggleDeadLane = useCallback((name: string) => {
    setExpandedDead(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const expandTraceGroup = useCallback((kind: DeadKind) => {
    setExpandedDead(prev => {
      const next = new Set(prev);
      for (const l of inactive?.groups[kind] ?? []) next.add(l.name);
      return next;
    });
  }, [inactive]);
```

`handleOpenRepo` 与 `handleOpenLatestRepo` 的成功分支里（`setSelectedCommit(null)` 旁）加：

```typescript
        setExpandedDead(new Set());
```

`handleViewFromBranch` 成功分支加（被查看分支视作已展开）：

```typescript
      setExpandedDead(new Set([branchName]));
```

- [ ] **Step 3: filterByBranches 不变量 + 面板分组排除死泳道**

`panelEnabled` / `panelDisabled` 改为排除死泳道：

```typescript
  const panelEnabled = useMemo(
    () => filteredBranches.filter(b => selectedBranches.includes(b.name) && !allDeadNames.has(b.name)),
    [filteredBranches, selectedBranches, allDeadNames],
  );
  const panelDisabled = useMemo(
    () => filteredBranches.filter(b => !selectedBranches.includes(b.name) && !allDeadNames.has(b.name)),
    [filteredBranches, selectedBranches, allDeadNames],
  );
```

`inlineBranches` 的两段过滤同样加 `&& !allDeadNames.has(b.name)`（header 工具栏 chip 不显示死泳道）。

**不变量说明（给实现者）**：死泳道永远留在 `selectedBranches`（打开时初始化为全部 lane 名，死泳道的 chip 只走 `toggleDeadLane`，不经过 `toggleBranchFilter`），所以任何活跃组勾选触发的 `filterByBranches` 重建都带着全部死泳道名——它们保持加载，只是视觉收拢。All 按钮传 `branchList.map(b => b.name)` 天然包含死泳道，无需改。

新分组 memo（`panelDisabled` 之后）：

```typescript
  const byActivity = (a: BranchLane, b: BranchLane) =>
    (refActivity.get(b.name) ?? 0) - (refActivity.get(a.name) ?? 0);
  const panelArchived = useMemo(
    () => [...(inactive?.groups.archived ?? [])].sort(byActivity),
    [inactive, refActivity],
  );
  const panelDormant = useMemo(
    () => [...(inactive?.groups.dormant ?? [])].sort(byActivity),
    [inactive, refActivity],
  );
```

- [ ] **Step 4: 定位与方向键**

`handleLocate` 改为（落到收拢泳道时先展开）：

```typescript
  const handleLocate = useCallback((r: LocateResult) => {
    const id = r.kind === 'branch' ? r.commitId : r.id;
    // Locate may land on a collapsed inactive lane: expand it first so the
    // focus centers on a real row (mirrors compressed-lane auto-expansion).
    const c = gitData?.commits.find(x => x.id === id);
    if (c && inactive?.dead.has(c.lane_owner)) {
      setExpandedDead(prev => new Set(prev).add(c.lane_owner));
    }
    focusSeqRef.current += 1;
    setFocusTarget({ id, seq: focusSeqRef.current });
    handleCommitClick(id);
    setLocateQuery('');
    setLocateOpen(false);
  }, [handleCommitClick, gitData, inactive]);
```

方向键 handler 里 `const lane = gitData.commits.filter(...)` 改为（只在可见 commits 间走）：

```typescript
      const lane = gitData.commits.filter(
        c => c.lane_owner === current.lane_owner && !hiddenIds.has(c.id),
      );
```

该 useEffect 的 deps 数组补 `hiddenIds`。

- [ ] **Step 5: Timeline props 换真值 + 面板 JSX**

`<Timeline>` 的 `data={gitData}` 改为 `data={view?.data ?? gitData}`，四个占位 prop 替换为：

```tsx
              hiddenIds={hiddenIds}
              traceRows={view?.traceRows ?? []}
              traceBars={view?.traceBars ?? []}
              onExpandTraceGroup={expandTraceGroup}
```

死泳道 chip 渲染函数（`renderBranchChip` 旁）：

```typescript
  const renderDeadChip = (branch: BranchLane) => (
    <button
      key={branch.name}
      className={`filter-tag ${expandedDead.has(branch.name) ? 'active' : ''}`}
      style={{
        borderColor: branch.color,
        backgroundColor: expandedDead.has(branch.name) ? branch.color : 'transparent',
      }}
      onClick={() => toggleDeadLane(branch.name)}
      title={branch.name}
    >
      {truncateMiddle(branch.name)}
    </button>
  );
```

面板 JSX：`panelDisabled` 组之后、`</div>`（branch-panel-list 收口）之前加两组：

```tsx
              {panelArchived.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">
                    {t('archivedLanes', { n: panelArchived.length })}
                    <button className="view-btn dead-group-btn" onClick={() => expandTraceGroup('archived')}>
                      {t('expandGroup')}
                    </button>
                  </div>
                  <div className="branch-panel-chips">
                    {panelArchived.map(renderDeadChip)}
                  </div>
                </div>
              )}
              {panelDormant.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">
                    {t('dormantLanes', { n: panelDormant.length })}
                    <button className="view-btn dead-group-btn" onClick={() => expandTraceGroup('dormant')}>
                      {t('expandGroup')}
                    </button>
                  </div>
                  <div className="branch-panel-chips">
                    {panelDormant.map(renderDeadChip)}
                  </div>
                </div>
              )}
```

App.css 追加：

```css
.branch-panel-group-title .dead-group-btn {
  margin-left: 8px;
  padding: 0 8px;
  font-size: 10px;
  vertical-align: middle;
}
```

- [ ] **Step 6: 验证**

Run: `npm run build && npm test`
Expected: 都通过。

浏览器功能验证（mock.html 需要有死泳道的场景数据；若当前 `public/mock-data.json` 来自活跃仓库看不到效果，先执行 Task 7 Step 1 的 dump 再回来验证——两个任务可交叉）：
1. 打开 mock.html，默认看到痕迹行（`.trace-bar` 元素存在）与 rail 上的「已归档/休眠」chip。
2. 点痕迹行 → 整组泳道恢复真实行，痕迹行消失。
3. 面板里勾选/取消单条死分支 chip → 单泳道展开/收拢。
4. 设置切阈值到「不收拢」→ 一切如旧；切回 90 → 恢复收拢。
5. Cmd+F 搜死分支名 → 落点泳道自动展开。

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.css
git commit -m "feat: wire inactive-lane collapse into app state and branch panel

computeInactive + collapseLanes memo pipeline feeds Timeline; dead lanes
stay in the filterByBranches rebuild set (loaded, visually collapsed);
panel gets Archived/Dormant groups with per-lane restore; locate auto-
expands the target lane; arrow-key nav walks visible commits only.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 端到端验收（合成大仓库）+ 文档收尾

**Files:**
- Create: `docs/tools/gen_inactive_repo.sh`
- Modify: `AGENTS.md`（前端测试基建描述）、`docs/roadmap.md`（勾掉 M1.2）、`docs/work-backstory/inactive-lane-collapse.md`（resolve）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 验收证据（≤30 泳道 + 痕迹行 + 全链路交互）+ 文档同步。

- [ ] **Step 1: 生成合成仓库脚本**

`docs/tools/gen_inactive_repo.sh`：

```bash
#!/usr/bin/env bash
# Acceptance fixture for M1.2: a repo with ~1000 branches where most are
# long-dead (merged or abandoned), ~25 are active, plus a release/* pile
# and protected env branches. Usage: gen_inactive_repo.sh <target-dir>
set -euo pipefail
dir="${1:?usage: gen_inactive_repo.sh <target-dir>}"
mkdir -p "$dir" && cd "$dir"
git init -q -b main
git config user.email t@t && git config user.name t
old=$(date -v-400d +%s 2>/dev/null || date -d '400 days ago' +%s)
new=$(date +%s)
c() { GIT_AUTHOR_DATE="@$1" GIT_COMMITTER_DATE="@$1" git commit -q --allow-empty -m "$2"; }

# main + dev base
c "$old" "base" && git branch -q dev
# ~500 merged dead feature branches
for i in $(seq 1 500); do
  git checkout -q -b "feat/$i" main
  c "$((old + i))" "feat $i"
  git checkout -q main && git merge -q --no-ff "feat/$i" -m "merge feat/$i"
done
# ~450 abandoned (never merged) dead branches
for i in $(seq 1 450); do
  git checkout -q -b "wip/$i" main
  c "$((old + i))" "wip $i"
done
# a pile of old release/* (must NOT be name-protected: wildcards excluded)
for i in $(seq 1 100); do
  git branch -q "release/v1.$i" main
done
# protected env branches, quiet but load-bearing
git branch -q uat main && git branch -q staging main
# ~25 active branches on top of recent main
git checkout -q main && c "$new" "recent main"
for i in $(seq 1 25); do
  git checkout -q -b "now/$i" main && c "$new" "active $i"
done
git checkout -q main
echo "done: $(git branch | wc -l | tr -d ' ') branches in $dir"
```

```bash
chmod +x docs/tools/gen_inactive_repo.sh
```

- [ ] **Step 2: dump 成 mock 数据并验证**

```bash
bash docs/tools/gen_inactive_repo.sh /tmp/gtv-accept
cd src-tauri && cargo run --example dump_json -- /tmp/gtv-accept > ../public/mock-data.json && cd ..
npm run dev -- --port 1421 &
```

（端口先探测：`curl -s localhost:1421` 不通才起；执行者用 /browse 或 playwright 打开 `http://localhost:1421/mock.html`。）

验收断言（浏览器里逐条确认并截图）：
1. 默认视图 lane rail 上 `.lane-chip:not(.trace-chip)` 数量 ≤ 30（main/dev/uat/staging + 25 条 active + 少量 fork 闭包命中的祖先）。
2. 存在 `.trace-bar` 元素，且 rail 有 `已归档`/`休眠` 两个 `.trace-chip`。
3. 点痕迹行 → 泳道恢复；再从面板「展开」单条恢复。
4. Cmd+F 定位一条 `wip/123` 分支 → 该泳道自动展开。
5. 设置切「不收拢」→ 全量泳道渲染。

- [ ] **Step 3: 真实仓库冒烟**

对 taskon-server（或手边任一真实仓库）`npm run tauri dev` 手动开一次：打开、看痕迹行、展开、收拢、搜索，无 console 错误。（执行者跑不了的，标注让用户手动过一遍。）

- [ ] **Step 4: 后端回归确认（应零变化）**

```bash
cd src-tauri && cargo test --test layout_pure --test pagination
```

Expected: 全过（tour_repo 两失败为已知 fixture 问题，不算回归）。

- [ ] **Step 5: 文档同步**

- `AGENTS.md`：`## Build, run, and test commands` 加 `npm test`；"The frontend has no test setup" 段改为「前端纯函数测试用 vitest（目前仅 src/inactive.ts），其余自动化测试在 Rust」。
- `docs/roadmap.md`：M1.2 行标记完成（移入「已完成的地基」列表，注明实现形态）。
- `docs/work-backstory/inactive-lane-collapse.md`：Process 补实施过程中的意外/决策，Decisions/Lessons 蒸馏，`status: resolved`，commits 补齐本 arc 全部 SHA。
- 恢复 `public/mock-data.json` 为原内容（`git checkout -- public/mock-data.json`）——backstory Lessons 的既有约定。

- [ ] **Step 6: 最终 Commit**

```bash
git add AGENTS.md docs/roadmap.md docs/tools/gen_inactive_repo.sh docs/work-backstory/inactive-lane-collapse.md
git commit -m "docs: M1.2 acceptance fixture + sync docs; resolve backstory arc

gen_inactive_repo.sh builds a 1000+ branch repo (~950 dead, 25 active,
release/* pile, protected env branches) for the ≤30-lane acceptance.
AGENTS.md records the vitest setup; roadmap ticks M1.2.

Backstory: docs/work-backstory/inactive-lane-collapse.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险提示（实现者注意）

- **不要 mutate 原始 gitData**：`collapseLanes` 返回浅拷贝结构；分页增量（`loadDiffStats` 的 `setGitData(prev => ...)`）与 display memo 都依赖原对象不可变。
- **draw() 的 deps 数组**：漏一个新 prop 会出现「数据变了图不重画」的陈旧渲染，Task 5 Step 5 列的四个必须全加。
- **rail 上 trace chip 的生命周期**：靠 branches join 的 exit 清除（key 不在 branches 数据里），所以 trace chip 的追加必须放在 branches join **之后**。
- 视口锚定（分页重排）代码只按 x 补偿，而收拢不变 x——无需改动；不要"顺手"加 y 补偿。
