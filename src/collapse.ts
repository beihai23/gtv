import type { BranchLane, CommitNode } from './types';

// ---------------------------------------------------------------------------
// Compressed-view folded segments: under "Compress" a lane renders only its
// key commits; the rest fold into per-RUN chips (not one per-lane chip), so
// the user can see and expand each contiguous hidden stretch on its own.
// Pure module — Timeline renders the result, tests build graphs by hand.
// ---------------------------------------------------------------------------

export interface CollapsedRun {
  /** Lane number — the chip's y is lane_index * LANE_HEIGHT. */
  lane_index: number;
  /** Lane color (chip stroke); '#666' when the lane has no branch entry. */
  color: string;
  /** Commit ids of the folded run, x-ascending. */
  ids: string[];
  /** Chip center x = midpoint of the run's first/last commit x. */
  x: number;
}

/** Maximal consecutive runs of invisible commits, grouped per lane_owner
 *  and ordered by x. A commit is invisible when it is not a key commit and
 *  neither its lane nor the commit itself is expanded. hiddenIds (inactive-
 *  lane collapse) and unattributed commits (lane_owner '') never take part. */
export function collapsedRuns(
  commits: CommitNode[],
  branches: BranchLane[],
  hiddenIds: ReadonlySet<string>,
  expandedLanes: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
): CollapsedRun[] {
  const colorByLane = new Map(branches.map(b => [b.lane_index, b.color]));
  const byOwner = new Map<string, CommitNode[]>();
  for (const c of commits) {
    if (hiddenIds.has(c.id) || c.lane_owner === '') continue;
    const list = byOwner.get(c.lane_owner);
    if (list) list.push(c);
    else byOwner.set(c.lane_owner, [c]);
  }
  const runs: CollapsedRun[] = [];
  for (const [owner, list] of byOwner) {
    if (expandedLanes.has(owner)) continue;
    list.sort((a, b) => a.x - b.x);
    let run: CommitNode[] = [];
    const flush = () => {
      if (run.length === 0) return;
      runs.push({
        lane_index: run[0].lane,
        color: colorByLane.get(run[0].lane) ?? '#666',
        ids: run.map(c => c.id),
        x: (run[0].x + run[run.length - 1].x) / 2,
      });
      run = [];
    };
    for (const c of list) {
      if (!c.is_key && !expandedIds.has(c.id)) run.push(c);
      else flush();
    }
    flush();
  }
  return runs;
}
