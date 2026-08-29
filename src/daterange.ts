import type { DeadKind, InactiveInfo } from './inactive';
import type { BranchLane, CommitNode, GitData, TimeGap } from './types';

// ---------------------------------------------------------------------------
// Date-range display transform (roadmap M2.2). Pure frontend display state:
// the backend view is never re-queried -- commits outside the window are
// hidden and x is shifted so the leftmost visible commit sits at 0. This
// DELIBERATELY breaks M1.2's "x never moves" invariant: that rule constrains
// lane collapsing (same data, re-laid-out rows), while this is a data-level
// crop onto a different slice. Density (px/day) is preserved by pure
// translation, so zoom feel and the ruler's per-commit interpolation stay
// consistent with no hidden global scale.
// ---------------------------------------------------------------------------

export type DateRange =
  | { kind: 'all' }
  | { kind: 'preset'; days: number }
  | { kind: 'custom'; start: number; end: number }; // epoch seconds, inclusive

const SECONDS_PER_DAY = 86400;

interface Window {
  start: number;
  end: number;
}

/** Resolve a DateRange to an inclusive epoch-seconds window; null for 'all'.
 *  Preset anchors at the NEWEST LOADED commit timestamp (repo-local "now"),
 *  never wall-clock: on an inactive repo a wall-clock "last week" would be an
 *  empty view, while anchoring at latest activity always shows something
 *  (and loadOlder only appends older commits, so the anchor is stable).
 *  Degenerate inputs (preset with zero commits, custom start > end) yield a
 *  start > end window that admits nothing -- one defensive empty path. */
function windowOf(data: GitData, range: DateRange): Window | null {
  if (range.kind === 'all') return null;
  if (range.kind === 'custom') return { start: range.start, end: range.end };
  let end = Number.NEGATIVE_INFINITY;
  for (const c of data.commits) {
    if (c.timestamp > end) end = c.timestamp;
  }
  if (end === Number.NEGATIVE_INFINITY) {
    return { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
  }
  return { start: end - range.days * SECONDS_PER_DAY, end };
}

/** Clip gap bars to the visible x span [minX, maxX], shift by minX, and drop
 *  the ones left with no width. t_start/t_end are intentionally untouched:
 *  they still describe the gap's original temporal span, which is what the
 *  ruler's inGap check reads. */
function clipGaps(gaps: TimeGap[], minX: number, maxX: number): TimeGap[] {
  const out: TimeGap[] = [];
  for (const g of gaps) {
    const x1 = Math.max(g.x_start, minX);
    const x2 = Math.min(g.x_end, maxX);
    if (x2 - x1 <= 0) continue;
    out.push({ ...g, x_start: x1 - minX, x_end: x2 - minX });
  }
  return out;
}

/** Display transform (spec 4.2). 'all' returns the SAME reference (downstream
 *  memo identity is unchanged). Otherwise: commits filtered to the window,
 *  x shifted so the leftmost visible commit sits at 0 (pure shift, px/day
 *  density unchanged), time_gaps clipped to the visible x span then shifted
 *  (empty ones dropped), edges kept iff both endpoints survive.
 *  has_more/branches are passed through untouched. */
export function applyDateRange(data: GitData, range: DateRange): GitData {
  const win = windowOf(data, range);
  if (win === null) return data;
  const inWin = (c: CommitNode) => c.timestamp >= win.start && c.timestamp <= win.end;
  const commits = data.commits.filter(inWin);
  if (commits.length === 0) {
    // No visible commit -> no minX anchor exists. Safe empty view; branches
    // and has_more pass through so lane panels and paging state survive.
    return { ...data, commits: [], edges: [], time_gaps: [] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const c of commits) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
  }
  const visible = new Set(commits.map(c => c.id));
  return {
    ...data,
    commits: commits.map(c => ({ ...c, x: c.x - minX })),
    edges: data.edges.filter(e => visible.has(e.from) && visible.has(e.to)),
    time_gaps: clipGaps(data.time_gaps, minX, maxX),
  };
}

/** Non-tag lanes with ZERO commits in (already filtered) data, returned in
 *  computeInactive's InactiveInfo shape so App unions the dead maps AND the
 *  panel groups mirror these lanes. dead excludes expandedDead (chip expand
 *  returns the lane to the canvas as an empty visible row); groups keep ALL
 *  range-dead lanes INCLUDING expanded ones (panel shows them checked) --
 *  mirrors computeInactive's expand semantics (inactive.ts:112-116).
 *  Range-empty wins over the freshness rule: a lane active within 90 days
 *  but empty this week is still empty in the this-week view. Feed it the
 *  applyDateRange output; the union then goes through the existing
 *  collapseLanes so empty lanes sink to sediment rows and the panel
 *  grouping/expanding machinery is reused as-is. */
export function emptyLaneDead(data: GitData, expandedDead?: Set<string>): InactiveInfo {
  const dead = new Map<string, DeadKind>();
  const archived: BranchLane[] = [];
  const dormant: BranchLane[] = [];
  const live = new Set<number>(); // lane indexes owning at least one commit
  for (const c of data.commits) live.add(c.lane);
  for (const b of data.branches) {
    if (b.is_tag || live.has(b.lane_index)) continue;
    const kind = b.merged_into ? 'archived' : 'dormant';
    (kind === 'archived' ? archived : dormant).push(b);
    if (expandedDead?.has(b.name)) continue; // user restored it
    dead.set(b.name, kind);
  }
  return { dead, groups: { archived, dormant } };
}

/** Commit ids outside the window (from the ORIGINAL unfiltered data).
 *  App feeds these into hidden-set unions (arrow-key stepping) and in_view
 *  overrides (locate). Empty set for 'all'. */
export function outOfRangeIds(data: GitData, range: DateRange): Set<string> {
  const win = windowOf(data, range);
  const out = new Set<string>();
  if (win === null) return out;
  for (const c of data.commits) {
    if (c.timestamp < win.start || c.timestamp > win.end) out.add(c.id);
  }
  return out;
}
