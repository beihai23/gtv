import type { BranchRef } from './types';

/** Hide remote-tracking refs (origin/*) from badge/tooltip/detail layers;
 *  lane labels use short names and are unaffected (spec 4.3).
 *  false passes the ORIGINAL array through so downstream memo identity
 *  holds; true returns a filtered copy. */
export function filterRefs(refs: BranchRef[], hideRemotes: boolean): BranchRef[] {
  return hideRemotes ? refs.filter(r => !r.is_remote) : refs;
}

/** The lane-level half of the remotes toggle: drop remote-only branch names
 *  from a selection before it goes to filterByBranches. Their lanes vanish
 *  from the view while the backend's ancestor-lane closure keeps any that
 *  are fork parents as render context. An all-remote selection would empty
 *  the view, so that case passes the original through. */
export function pruneRemoteLanes(names: string[], remoteNames: ReadonlySet<string>): string[] {
  const pruned = names.filter(n => !remoteNames.has(n));
  return pruned.length > 0 ? pruned : names;
}
