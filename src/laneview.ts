// ---------------------------------------------------------------------------
// Lane view modes (the map-model redesign). A mode is a DISPLAY-level
// narrowing: it computes which alive lanes fold into the sediment rows —
// instant, reversible, no backend round trip. The backend selection
// (filterByBranches) is untouched by modes; stars are the persisted
// "branches I care about" marks (the old pins).
// ---------------------------------------------------------------------------

import type { BranchLane } from './types';

export type LaneViewMode = 'all' | 'starred' | 'active';

/** How many lanes the `active` mode keeps (most recent activity first). */
export const ACTIVE_MODE_SIZE = 5;

/** Lanes folded by a narrowed view mode. Rules:
 *  - 'all' folds nothing.
 *  - 'starred' folds every alive lane that is not starred.
 *  - 'active' keeps the ACTIVE_MODE_SIZE most recently active lanes.
 *  - HEAD's lane always survives (you are here; hiding "here" is hostile).
 *  - `restored` (lanes the user manually re-opened; in the starred mode the
 *    caller also passes the stars themselves so starred DEAD lanes surface)
 *    always wins over the mode.
 *  - A mode that would fold EVERY alive lane blanks the canvas -- no-op
 *    instead (stars pointing only at nonexistent lanes, say). */
export function modeHiddenLanes(
  mode: LaneViewMode,
  aliveLanes: BranchLane[],
  starred: ReadonlySet<string>,
  headBranch: string | null,
  activityOf: (name: string) => number,
  restored: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  if (mode === 'all') return hidden;

  const keep = new Set<string>(starred);
  if (headBranch) keep.add(headBranch);
  if (mode === 'active') {
    const top = [...aliveLanes]
      .sort((a, b) => activityOf(b.name) - activityOf(a.name))
      .slice(0, ACTIVE_MODE_SIZE);
    for (const l of top) keep.add(l.name);
  }

  for (const l of aliveLanes) {
    if (keep.has(l.name) || restored.has(l.name)) continue;
    hidden.add(l.name);
  }
  if (hidden.size > 0 && hidden.size === aliveLanes.length) return new Set();
  return hidden;
}
