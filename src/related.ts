import type { BranchLane, GitData } from './types';

// ---------------------------------------------------------------------------
// Related-lane filter (roadmap M2.1). Pure function over the loaded window:
// the blood-line closure of one lane, used to rebuild the view with only
// related branches. Unresolvable fork/merge oids (commits outside the
// loaded window) simply truncate the walk; main_branch is the guaranteed
// base the truncated chains fall back to.
// ---------------------------------------------------------------------------

/** Lane blood-line closure (spec 4.1): target + fork up-chain (single
 *  line, no siblings) + fork descendants (branching down) + one-hop
 *  mergeTarget of every lane in that set + main_branch always. */
export function relatedLanes(data: GitData, target: string): Set<string> {
  const realLanes = data.branches.filter(b => !b.is_tag);
  const laneByName = new Map(realLanes.map(l => [l.name, l]));
  const laneByIndex = new Map(realLanes.map(l => [l.lane_index, l]));
  const laneOfCommit = new Map(data.commits.map(c => [c.id, c.lane]));

  // fork_point / merged_into are commit oids; the owning lane is whoever
  // owns that commit in the loaded window. Oids outside it are unresolvable.
  const laneOwning = (oid: string | null): BranchLane | undefined => {
    if (!oid) return undefined;
    const idx = laneOfCommit.get(oid);
    return idx !== undefined ? laneByIndex.get(idx) : undefined;
  };

  // Defensive: unknown target (or a tag lane) degrades to main only.
  if (!laneByName.has(target)) return new Set([data.main_branch]);

  // Up-chain: single line up, SIBLINGS EXCLUDED -- a lane forked from an
  // ancestor of the target is not the target's blood (the key difference
  // from an undirected closure). The core set doubles as the cycle guard.
  const core = new Set<string>();
  let cur: BranchLane | undefined = laneByName.get(target);
  while (cur && !core.has(cur.name)) {
    core.add(cur.name);
    cur = laneOwning(cur.fork_point);
  }

  // Descendants: BFS down the reverse fork edges from the TARGET only.
  // Branching down is legal -- every lane forked from B or its offspring
  // is B's blood; lanes forked from an ANCESTOR are siblings (excluded).
  const childrenOf = new Map<string, string[]>();
  for (const l of realLanes) {
    const p = laneOwning(l.fork_point);
    if (!p) continue;
    const list = childrenOf.get(p.name);
    if (list) list.push(l.name);
    else childrenOf.set(p.name, [l.name]);
  }
  const queue = [target];
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const child of childrenOf.get(name) ?? []) {
      if (core.has(child)) continue;
      core.add(child);
      queue.push(child);
    }
  }

  // Merge relations, ONE hop in both directions and never transitive:
  // forward adds where a core lane merged into (its tip lives in that
  // lane's history); reverse adds lanes merged INTO a core lane (their
  // tips live in the core lane's history, hence blood). Lanes joined only
  // via a merge edge contribute no further closure -- a merge target's own
  // merge target stays out.
  const out = new Set<string>(core);
  out.add(data.main_branch); // fork chains truncated by the window end here
  for (const name of core) {
    const t = laneOwning(laneByName.get(name)!.merged_into);
    if (t) out.add(t.name);
  }
  for (const l of realLanes) {
    const t = laneOwning(l.merged_into);
    if (t && core.has(t.name)) out.add(l.name);
  }
  return out;
}
