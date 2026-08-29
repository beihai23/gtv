import type { BranchRef } from './types';

/** Hide remote-tracking refs (origin/*) from badge/tooltip/detail layers;
 *  lane labels use short names and are unaffected (spec 4.3).
 *  false passes the ORIGINAL array through so downstream memo identity
 *  holds; true returns a filtered copy. */
export function filterRefs(refs: BranchRef[], hideRemotes: boolean): BranchRef[] {
  return hideRemotes ? refs.filter(r => !r.is_remote) : refs;
}
