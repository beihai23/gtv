//! Pure layout engine: assigns every commit to a branch lane using
//! first-parent lineage propagation, then produces typed edges
//! (Direct / Branch / Merge) and coordinates.
//!
//! 1:1 TypeScript port of src-tauri/src/layout.rs — no git dependency,
//! operates only on the shared models from src/types.ts.

import type {
  BranchLane,
  CommitEdge,
  CommitNode,
  TimeGap,
} from '../../../src/types';

// models.rs has a dedicated EdgeType enum; src/types.ts inlines it as a
// string union on CommitEdge. Alias it locally instead of editing the
// shared mirror.
type EdgeType = CommitEdge['edge_type'];

export const MAIN_COLOR = '#4A90D9';
export const TAG_COLOR = '#9C27B0';

// Reserved semantic colors must never appear here: the UI paints the
// checked-out lane's ring/band/arrow in #4CAF50 ("you are here" green)
// and every tag ref in TAG_COLOR, so a lane painted the same hex would
// fake that meaning. MAIN_COLOR stays out for the same reason (lane 0
// is fixed to it separately).
export const LANE_PALETTE: readonly string[] = [
  '#E91E63', '#FF9800', '#009688', '#FF5722', '#3F51B5',
  '#8BC34A', '#00BCD4', '#795548', '#673AB7', '#607D8B',
];

/// Single source of truth for lane colors. Lane 0 (main) is fixed;
/// everything else rotates through the palette.
export function laneColor(laneIndex: number): string {
  if (laneIndex <= 0) {
    return MAIN_COLOR;
  }
  return LANE_PALETTE[(laneIndex - 1) % LANE_PALETTE.length];
}

/// A branch ref that seeds one lane.
export interface LaneSeed {
  /// Display name of the lane (short branch name, no refs/ prefix;
  /// `origin/x` for remote-only branches).
  name: string;
  /// Oid of the commit the branch points to.
  tip: string;
  /// True when the seed comes from a remote-tracking ref with no local
  /// counterpart.
  is_remote: boolean;
  /// Upstream tips of the same branch folded into this lane's walk starts
  /// (a local branch shadows the remote lane, but the remote tip still
  /// claims for it so upstream-only history stays attributable).
  extra_tips?: string[];
}

const LANE_HEIGHT = 80.0;

// Rust i64 sentinels, used only as sort-key extremes. -2^63 is exactly
// representable in f64; +2^63-1 rounds to 2^63, which is still the
// largest key in play, so the ordering is unaffected.
const I64_MIN = -9223372036854775808;
const I64_MAX = 9223372036854775807;

/// Longest-path depth of each commit above its oldest loaded ancestor
/// (0 = no parent in the loaded set). Used only as the within-second
/// sort tiebreak so equal-timestamp commits order parents before
/// children. Iterative post-order walk — recursion would overflow the
/// stack on a 10k-commit window. A parent still on the DFS stack would
/// mean a cycle (corrupt repo); it is ignored rather than looping.
function topoDepth(commits: CommitNode[], indexOf: Map<string, number>): number[] {
  const ON_STACK = 1;
  const DONE = 2;
  const n = commits.length;
  const state = new Uint8Array(n);
  const depth = new Array<number>(n).fill(0);
  for (let start = 0; start < n; start++) {
    if (state[start] !== 0) {
      continue;
    }
    state[start] = ON_STACK;
    const stack = [start];
    while (stack.length > 0) {
      const i = stack[stack.length - 1];
      let allDone = true;
      let maxParent: number | null = null;
      for (const p of commits[i].parents) {
        const pi = indexOf.get(p);
        if (pi === undefined) {
          continue;
        }
        if (state[pi] === DONE) {
          maxParent = maxParent === null ? depth[pi] : Math.max(maxParent, depth[pi]);
        } else if (state[pi] === ON_STACK) {
          // defensive: cycle in corrupt data
        } else {
          state[pi] = ON_STACK;
          stack.push(pi);
          allDone = false;
        }
      }
      if (allDone) {
        depth[i] = maxParent === null ? 0 : maxParent + 1;
        state[i] = DONE;
        stack.pop();
      }
    }
  }
  return depth;
}

/// Core entry point. `commits` may be in any order; they are sorted by
/// timestamp (oldest first) inside. Mutates commits in place (lane,
/// lane_owner, x, y, is_head, fork/merge labels) and returns the lane
/// list, typed edges, and folded time gaps (axis breaks).
export function computeLayout(
  commits: CommitNode[],
  seeds: LaneSeed[],
  mainBranch: string,
  headId: string | null,
): { lanes: BranchLane[]; edges: CommitEdge[]; timeGaps: TimeGap[] } {
  if (commits.length === 0) {
    return { lanes: [], edges: [], timeGaps: [] };
  }

  const indexOf = new Map<string, number>();
  commits.forEach((c, i) => indexOf.set(c.id, i));

  // owner[i] = lane name that claimed commits[i]
  const owner: (string | null)[] = new Array(commits.length).fill(null);

  // Seed order decides who claims shared ancestry first. Main claims
  // first unconditionally: no precedence edge may ever demote the trunk
  // behind a side branch. (The removed R1 rule — "a seed whose tip lies
  // on another's first-parent chain claims first" — did exactly that:
  // an ancestor-tip branch like release/x, ordered before main, walked
  // straight down the mainline and stole its whole history, because from
  // its own tip it never hits main's tip wall.)
  //   R2 (merge destination): seed S's tip is a non-first parent of a
  //      merge commit m, and m lies on seed T's first-parent chain
  //      -> T claims before S, EXCEPT when S is main: merging main into
  //      your branch (a sync merge) must not demote main. (The old rule
  //      gave merged SOURCES unconditional priority, which handed the
  //      destination branch's own history to the merged branch whenever
  //      the destination was not main.)
  // R2 edges are resolved with Kahn's algorithm; among the ready
  // (in-degree 0) seeds a soft key picks: main first, then lanes whose
  // tip was merged into another lane (the merge record proves their
  // lineage was integrated as a unit — covers "Y merged into main, Z
  // forked mid-Y"), newest tip first, name as the final tiebreak. A cycle
  // (mutual merges) is broken by the same soft key so the sort always
  // terminates. Ordering alone does not protect branch tips — the tip
  // wall in the claiming loop below does (a walk stops at another lane's
  // tip commit regardless of who walks first). When the DAG offers no
  // evidence at all — two branches forked out of each other's mid-region
  // with no merge and no ancestry relation — the direction is genuinely
  // ambiguous and newest-tip-first decides; that residual misattribution
  // is the documented heuristic limit.
  const mergedTips = new Set<string>();
  for (const c of commits) {
    for (const p of c.parents.slice(1)) {
      mergedTips.add(p);
    }
  }

  // First-parent chain (commit ids) of each seed, stopping at the window
  // edge: the union of the chains walked from the tip and every extra tip.
  // The has-check also guards against a corrupt cycle.
  const chains: Set<string>[] = seeds.map((s) => {
    const set = new Set<string>();
    for (const start of [s.tip, ...(s.extra_tips ?? [])]) {
      let cursor = indexOf.get(start);
      while (cursor !== undefined) {
        if (set.has(commits[cursor].id)) {
          break;
        }
        set.add(commits[cursor].id);
        const first: string | undefined = commits[cursor].parents[0];
        cursor = first !== undefined ? indexOf.get(first) : undefined;
      }
    }
    return set;
  });

  // Precedence edges (before, after) as seed-index pairs, deduped.
  const precedence = new Set<string>();
  // R2: S's tip merged at m, m on T's chain -> T before S. Main is
  // exempt as the source: a sync merge (main merged into a side branch)
  // must not order that branch before the trunk.
  for (const m of commits) {
    if (m.parents.length < 2) {
      continue;
    }
    for (const parent of m.parents.slice(1)) {
      for (let s = 0; s < seeds.length; s++) {
        if (seeds[s].tip !== parent || seeds[s].name === mainBranch) {
          continue;
        }
        for (let t = 0; t < seeds.length; t++) {
          if (t !== s && chains[t].has(m.id)) {
            precedence.add(`${t}:${s}`);
          }
        }
      }
    }
  }

  // Soft priority key (lower wins): main class, merged-tip class, the
  // rest; newest tip first within a class (descending ts instead of
  // negation: -i64::MIN overflows in Rust for tips outside the window);
  // name as a stable tiebreak.
  const softKey = (s: LaneSeed): [number, number, string] => {
    const cls = s.name === mainBranch ? 0 : mergedTips.has(s.tip) ? 1 : 2;
    const ti = indexOf.get(s.tip);
    const ts = ti !== undefined ? commits[ti].timestamp : I64_MIN;
    return [cls, ts, s.name];
  };
  const compareSoft = (a: LaneSeed, b: LaneSeed): number => {
    const ka = softKey(a);
    const kb = softKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return kb[1] - ka[1]; // newest tip first
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  };

  // Kahn's algorithm over the precedence edges; each round takes the
  // soft-key-smallest ready seed. No ready seed means a cycle — take the
  // soft-key-smallest remaining seed outright to guarantee termination.
  const successors: number[][] = seeds.map(() => []);
  const indegree = new Array<number>(seeds.length).fill(0);
  for (const e of precedence) {
    const [before, after] = e.split(':').map(Number);
    successors[before].push(after);
    indegree[after] += 1;
  }
  const done = new Array<boolean>(seeds.length).fill(false);
  const orderedSeeds: LaneSeed[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < seeds.length; i++) {
      if (!done[i] && indegree[i] === 0 && (pick < 0 || compareSoft(seeds[i], seeds[pick]) < 0)) {
        pick = i;
      }
    }
    if (pick < 0) {
      // Cycle: fall back to the soft-key-smallest remaining seed.
      for (let i = 0; i < seeds.length; i++) {
        if (!done[i] && (pick < 0 || compareSoft(seeds[i], seeds[pick]) < 0)) {
          pick = i;
        }
      }
    }
    if (pick < 0) break;
    done[pick] = true;
    orderedSeeds.push(seeds[pick]);
    for (const next of successors[pick]) {
      indegree[next] -= 1;
    }
  }

  // Branch tips act as walls: a tip commit belongs to its own branch even
  // if a descendant branch claims its lineage first (branch-from-branch
  // case). Main is the exception — it claims straight through reservations
  // so a fast-forwarded side branch never splits the mainline.
  const tipOf = new Map<number, string>();
  for (const s of orderedSeeds) {
    const ti = indexOf.get(s.tip);
    if (ti !== undefined) {
      tipOf.set(ti, s.name);
    }
  }

  // lane name -> fork point commit id
  const forkPoints = new Map<string, string>();
  // lane names in claim order (main first)
  const laneNames: string[] = [];

  for (const seed of orderedSeeds) {
    const laneName = seed.name;
    const isMain = laneName === mainBranch;
    let lanePushed = false;

    // One lane, one claim per start: the branch tip plus every folded
    // upstream tip. A start whose tip is already claimed (or outside
    // the window) is skipped on its own; the lane name is registered
    // at the first start that actually claims.
    for (const start of [seed.tip, ...(seed.extra_tips ?? [])]) {
      const startIdx = indexOf.get(start);
      if (startIdx === undefined) {
        continue; // tip outside the walked window
      }
      if (owner[startIdx] !== null) {
        continue; // zero-length start: points at an already-claimed commit
      }
      if (!lanePushed) {
        laneNames.push(laneName);
        lanePushed = true;
      }

      // Walk first-parent chain from the start, claiming until we hit a
      // commit already owned by another lane or reserved as another
      // lane's tip — that commit is the fork point.
      let cursor: number | undefined = startIdx;
      while (cursor !== undefined) {
        // Explicit annotations break a TS control-flow narrowing cycle
        // (cursor -> first -> commits[i] -> i -> cursor).
        const i: number = cursor;
        const tipName = tipOf.get(i);
        const blocked =
          owner[i] !== null || (!isMain && tipName !== undefined && tipName !== laneName);
        if (blocked) {
          if (owner[i] === laneName) {
            break; // two starts of the same lane converge — not a fork
          }
          // First-wins: two diverged starts may hit different lanes; keep
          // the fork point recorded first.
          if (!forkPoints.has(laneName)) {
            forkPoints.set(laneName, commits[i].id);
          }
          break;
        }
        owner[i] = laneName;
        const first: string | undefined = commits[i].parents[0];
        cursor = first !== undefined ? indexOf.get(first) : undefined;
      }
    }
  }

  // Lane purity: a lane renders exactly the first-parent lineage of its
  // own branch — merged-in content from other branches is that other
  // branch's history, never this lane's. Commits no seed claimed belong
  // to NO rendered lane: mark them unattributed ("") and the frontend
  // hides them and their edges outright. Ref-carrying strays and
  // anonymous strays are handled identically — absorbing either into a
  // lane would misattribute foreign lineage.
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === null) {
      owner[i] = '';
    }
  }

  // Vertical lane order: main on top, others by fork-point time
  // (born earlier = closer to main), ties broken by tip recency.
  const tsOf = (id: string): number => {
    const i = indexOf.get(id);
    return i !== undefined ? commits[i].timestamp : 0;
  };
  const sideLanes = laneNames.slice(1);
  // Compound key (fork_ts, name): Rust string Ord is byte-wise, matching
  // JS < on ASCII names. Sort stays stable for exact ties.
  sideLanes.sort((a, b) => {
    const fa = forkPoints.has(a) ? tsOf(forkPoints.get(a)!) : I64_MAX;
    const fb = forkPoints.has(b) ? tsOf(forkPoints.get(b)!) : I64_MAX;
    if (fa !== fb) {
      return fa - fb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const laneIndexOf = new Map<string, number>();
  const remoteOf = new Map<string, boolean>();
  for (const s of seeds) {
    remoteOf.set(s.name, s.is_remote);
  }
  const lanes: BranchLane[] = [];
  if (laneNames.length > 0) {
    const mainName = laneNames[0];
    laneIndexOf.set(mainName, 0);
    lanes.push({
      name: mainName,
      lane_index: 0,
      color: laneColor(0),
      is_tag: false,
      fork_point: null,
      merged_into: null,
      is_active: true,
      is_remote: remoteOf.get(mainName) ?? false,
    });
  }
  sideLanes.forEach((name, k) => {
    const idx = k + 1;
    laneIndexOf.set(name, idx);
    lanes.push({
      name,
      lane_index: idx,
      color: laneColor(idx),
      is_tag: false,
      fork_point: forkPoints.get(name) ?? null,
      merged_into: null,
      is_active: true,
      is_remote: remoteOf.get(name) ?? false,
    });
  });

  // Detect where each lane was merged: any of the lane's tips (branch tip
  // plus folded upstream tips) appears as a non-first parent of a merge
  // commit on another lane.
  const tipsOfSeed = new Map<string, string[]>();
  for (const s of seeds) {
    tipsOfSeed.set(s.name, [s.tip, ...(s.extra_tips ?? [])]);
  }
  for (const lane of lanes) {
    const tips = tipsOfSeed.get(lane.name);
    if (tips === undefined) {
      continue;
    }
    for (const c of commits) {
      if (c.parents.length > 1 && c.parents.slice(1).some((p) => tips.includes(p))) {
        lane.merged_into = c.id;
        break;
      }
    }
  }

  // Assign lane numbers + ownership to commits.
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const laneName = owner[i] ?? mainBranch;
    c.lane = laneIndexOf.get(laneName) ?? 0;
    c.lane_owner = laneName;
    c.is_head = headId !== null && headId === c.id;
  }

  // Typed edges + fork/merge annotations.
  const edges: CommitEdge[] = [];
  for (let i = 0; i < commits.length; i++) {
    const childOwner = owner[i] ?? '';
    const parents = commits[i].parents;
    for (let pPos = 0; pPos < parents.length; pPos++) {
      const parentId = parents[pPos];
      const pi = indexOf.get(parentId);
      if (pi === undefined) {
        continue;
      }
      const parentOwner = owner[pi] ?? '';
      const isMergeLink = parents.length > 1 && pPos > 0;
      const isForkEdge =
        !isMergeLink &&
        parentOwner !== childOwner &&
        forkPoints.get(childOwner) === parentId;

      let edgeType: EdgeType;
      if (isMergeLink) {
        if (parentOwner !== '' && parentOwner !== childOwner) {
          commits[i].merge_branch_name = parentOwner;
        } else if (parentOwner === '') {
          // The merged-in lineage is unattributed (hidden). The merge node
          // stays on the lane — label it from the hidden parent's own
          // branch refs so "what came in here" remains readable.
          const ref = commits[pi].branch_refs.find((r) => !r.is_tag);
          commits[i].merge_branch_name = ref
            ? ref.name.startsWith('origin/')
              ? ref.name.slice('origin/'.length)
              : ref.name
            : null;
        }
        edgeType = 'Merge';
      } else if (isForkEdge) {
        // Annotate the fork point commit (on the parent lane).
        // Multiple lanes may fork from the same commit; join names.
        const entry = commits[pi].fork_branch_name ?? '';
        commits[pi].fork_branch_name = entry === '' ? childOwner : `${entry}, ${childOwner}`;
        edgeType = 'Branch';
      } else {
        edgeType = 'Direct';
      }

      edges.push({ from: commits[i].id, to: parentId, edge_type: edgeType });
    }
  }

  // Key-node marking (gmaster-style smart compression): a commit survives
  // compression if it is HEAD, carries refs (tips/tags), is a merge commit,
  // is a merge source, is a fork point, is its lane's first own commit,
  // or is its lane's tip within the loaded window.
  const isMergeSource = new Set<number>();
  const hasSameLaneChild = new Set<number>();
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    for (let pPos = 0; pPos < c.parents.length; pPos++) {
      const pi = indexOf.get(c.parents[pPos]);
      if (pi !== undefined) {
        if (pPos > 0) {
          isMergeSource.add(pi);
        } else if (owner[pi] === owner[i]) {
          hasSameLaneChild.add(pi);
        }
      }
    }
  }
  const forkPointIds = new Set(forkPoints.values());
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const firstParent = c.parents[0];
    let isLaneBirth: boolean;
    if (firstParent === undefined) {
      isLaneBirth = true;
    } else {
      const pi = indexOf.get(firstParent);
      isLaneBirth = pi !== undefined ? owner[pi] !== owner[i] : false;
    }
    c.is_key =
      c.is_head ||
      c.branch_refs.length > 0 ||
      c.parents.length > 1 ||
      isMergeSource.has(i) ||
      forkPointIds.has(c.id) ||
      isLaneBirth ||
      !hasSameLaneChild.has(i);
    // Unattributed lineage never renders as a key node — the frontend
    // hides it outright, and keeping it out of the key set also keeps it
    // out of the x-cascade and the minimap.
    if (c.lane_owner === '') {
      c.is_key = false;
    }
  }

  // Time-proportional x with ONE global min-spacing cascade over the key
  // commits of all lanes, in time order. (Per-lane cascades put the same
  // timestamp at different x on different lanes, so no time ruler could
  // track the nodes.) With a single cascade, x is a monotone function of
  // time shared by every lane, and the ruler's piecewise map is exact at
  // every commit.
  // Sort by timestamp, breaking ties topologically (parents first).
  // Same-second committer timestamps are common — a rebase rewrites a
  // whole branch in one second — and the walk feeds us newest-first,
  // so a plain stable sort would order a tied group child-before-
  // parent and the cascade below would place branch tips LEFT of
  // their own ancestors.
  const depth = topoDepth(commits, indexOf);
  const order = commits.map((_, i) => i);
  order.sort((a, b) => {
    if (commits[a].timestamp !== commits[b].timestamp) {
      return commits[a].timestamp - commits[b].timestamp;
    }
    return depth[a] - depth[b];
  });
  // Reorder the caller's array in place (Rust: mem::take + push).
  const taken = commits.splice(0, commits.length);
  for (const idx of order) {
    commits.push(taken[idx]);
  }
  const tMin = commits.length > 0 ? commits[0].timestamp : 0;
  const PX_PER_DAY = 10.0;
  const MIN_SPACING = 28.0;
  const timeX = (ts: number): number => ((ts - tMin) / 86400.0) * PX_PER_DAY;

  // Pass 1: cascade the key commits (the nodes visible in the default
  // compressed view — they decide the scene's extent).
  let lastKeyX: number | null = null;
  for (const c of commits) {
    if (!c.is_key) {
      continue;
    }
    const tx = timeX(c.timestamp);
    // Annotated to break a narrowing cycle (x -> lastKeyX -> x).
    const x: number = lastKeyX !== null ? Math.max(tx, lastKeyX + MIN_SPACING) : tx;
    c.x = x;
    lastKeyX = x;
  }

  // Pass 2: each non-key commit sits ON the piecewise line between the
  // key commits bracketing it in the sorted order, so it too obeys the
  // shared time→x map. Inside a bracket the fraction is the timestamp
  // fraction raised to at least the even-spread rank fraction, so commits
  // sharing one second (rebase artifacts) fan out in topological order
  // instead of stacking on one x; a small monotone cascade keeps the run
  // strictly increasing even when several commits clamp to the same
  // fraction.
  let i = 0;
  let prevKey: [number, number] | null = null;
  while (i < commits.length) {
    if (commits[i].is_key) {
      prevKey = [commits[i].timestamp, commits[i].x];
      i += 1;
      continue;
    }
    let j = i;
    while (j < commits.length && !commits[j].is_key) {
      j += 1;
    }
    const nextKey: [number, number] | null =
      j < commits.length ? [commits[j].timestamp, commits[j].x] : null;
    const m = j - i;
    let lastF = 0.0;
    for (let k = 0; k < m; k++) {
      const c = commits[i + k];
      if (prevKey === null) {
        // Before the first key commit (oldest window commits of a
        // lane can be non-key): honest time-x, still monotone.
        c.x = timeX(c.timestamp);
      } else if (nextKey === null) {
        // After the last key: march right in fixed steps.
        c.x = prevKey[1] + (k + 1) * MIN_SPACING * 0.4;
      } else {
        const [ta, xa] = prevKey;
        const [tb, xb] = nextKey;
        const ft =
          tb > ta
            ? Math.min(Math.max((c.timestamp - ta) / (tb - ta), 0.05), 0.95)
            : 0.0;
        const fr = (k + 1) / (m + 1);
        const f = Math.min(Math.max(Math.max(ft, fr), lastF + 0.5 / (m + 1)), 0.98);
        lastF = f;
        c.x = xa + (xb - xa) * f;
      }
    }
    i = j;
  }
  for (const c of commits) {
    c.y = c.lane * LANE_HEIGHT;
  }

  // Fold anomalous empty time gaps (axis breaks). Any x-range wider than
  // ~45 days of emptiness holds no commits at all; collapse it to a fixed
  // width and record it so the renderer can draw a break marker and the
  // ruler can skip it. One bogus future-dated commit would otherwise
  // stretch the whole scene by tens of thousands of pixels.
  const GAP_MIN_PX = 45.0 * PX_PER_DAY;
  const GAP_PX = 120.0;
  const xs = commits.map((c) => c.x).sort((a, b) => a - b);
  const dedupedXs: number[] = [];
  for (const x of xs) {
    if (dedupedXs.length === 0 || Math.abs(x - dedupedXs[dedupedXs.length - 1]) >= 1e-6) {
      dedupedXs.push(x);
    }
  }
  // (origStart, origEnd, tStart, tEnd) in pre-fold coordinates
  const rawGaps: [number, number, number, number][] = [];
  for (let w = 0; w + 1 < dedupedXs.length; w++) {
    const w0 = dedupedXs[w];
    const w1 = dedupedXs[w + 1];
    if (w1 - w0 > GAP_MIN_PX) {
      let tStart = 0;
      let tEnd = 0;
      let hasStart = false;
      let hasEnd = false;
      for (const c of commits) {
        if (c.x <= w0 + 0.5 && (!hasStart || c.timestamp > tStart)) {
          tStart = c.timestamp;
          hasStart = true;
        }
        if (c.x >= w1 - 0.5 && (!hasEnd || c.timestamp < tEnd)) {
          tEnd = c.timestamp;
          hasEnd = true;
        }
      }
      rawGaps.push([w0, w1, tStart, tEnd]);
    }
  }
  const timeGaps: TimeGap[] = [];
  if (rawGaps.length > 0) {
    let shift = 0.0;
    for (const [gs, ge, ts, te] of rawGaps) {
      timeGaps.push({
        t_start: ts,
        t_end: te,
        x_start: gs - shift,
        x_end: gs - shift + GAP_PX,
      });
      shift += ge - gs - GAP_PX;
    }
    for (const c of commits) {
      let s = 0.0;
      for (const g of rawGaps) {
        if (c.x >= g[1] - 0.5) {
          s += g[1] - g[0] - GAP_PX;
        }
      }
      c.x -= s;
    }
  }

  return { lanes, edges, timeGaps };
}
