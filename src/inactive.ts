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
 *  <=30-lane acceptance on exactly those repos. Active ones are protected by
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
  // owned by ANOTHER lane (release/v1.x-style) have no own commits -- for
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

  // Fork-parent closure: walk UP from every kept lane -- every ancestor on
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
  // so the merge commit on the target lane is at least as fresh as that tip --
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
