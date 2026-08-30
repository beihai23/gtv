import { laneTips } from './locate';
import type { GitData } from './types';

// ---------------------------------------------------------------------------
// Two-commit compare pairing (roadmap M3.2, spec 4.4). Pure state machine
// for the Ctrl+click gesture plus the lane-menu "compare with HEAD" pair
// builder; the CompareDetails panel (Task 5) consumes what these produce.
// No React, no side effects.
// ---------------------------------------------------------------------------

export interface ComparePair { base: string; target: string }

/** Ctrl+click contract (spec 4.4). The half-selected state is target === ''.
 *  No pair, or a complete pair (target non-empty) -> the clicked commit
 *  becomes the new base with the target cleared; half-selected -> the
 *  clicked commit fills the target. base === target is allowed (an empty
 *  diff is shown honestly, spec 5) -- no dedup, no special cases. */
export function nextPair(pair: ComparePair | null, id: string): ComparePair {
  if (pair === null || pair.target !== '') return { base: id, target: '' };
  return { base: pair.base, target: id };
}

/** Lane-menu "compare with HEAD": base = HEAD commit id, target = the lane
 *  tip commit id (tip rule reused from locate.ts laneTips). null -- callers
 *  gray the menu item out -- when HEAD is not among the loaded commits
 *  (windowed or paged out), the lane is not in the branches registry, or
 *  the lane has no loaded commits. */
export function headToLaneTip(data: GitData, laneName: string): ComparePair | null {
  const head = data.commits.find(c => c.is_head);
  if (!head) return null;
  if (!data.branches.some(b => b.name === laneName)) return null;
  const tip = laneTips(data.commits).get(laneName);
  if (!tip) return null;
  return { base: head.id, target: tip.id };
}
