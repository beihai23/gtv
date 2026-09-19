import { describe, it, expect } from 'vitest';
import { applyDateRange, emptyLaneDead, outOfRangeIds } from './daterange';
import type { DateRange } from './daterange';
import type { BranchLane, CommitEdge, CommitNode, GitData, TimeGap } from './types';

// --- fixtures -------------------------------------------------------------

function lane(name: string, index: number, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: index, color: '#123456', is_tag: false,
    fork_point: null, merged_into: null, is_active: true, ...over,
  };
}

function commit(id: string, over: Partial<CommitNode> = {}): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: '', is_head: false, is_key: true,
    additions: 0, deletions: 0, x: 0, y: 0, lane: 0, ...over,
  };
}

function gitData(commits: CommitNode[], branches: BranchLane[], over: Partial<GitData> = {}): GitData {
  return {
    commits, edges: [], branches, main_branch: 'main', time_gaps: [],
    has_more: false, head_branch: null, head_commit_count: null, ...over,
  };
}

const DAY = 86400;
const BASE = 1_700_000_000; // epoch-seconds left edge of the preset window below
const lastDay: DateRange = { kind: 'preset', days: 1 };

// Master fixture for the preset cases: timestamps chosen so the 1-day preset
// window [BASE, BASE + DAY] (anchored at the newest loaded commit 'tip',
// NOT at wall-clock now -- these are 2023-era seconds and still survive)
// keeps {edge, mid, tip} and drops the two ancient commits. The brief
// sketched ts {100..900} with days=1, but that window [900 - 86400, 900]
// admits every positive timestamp, so nothing could ever be filtered; the
// numbers below keep the intent at epoch scale. Visible x span after the
// filter: [130, 210] (old5/old100 at x 0/10 drop out).
const presetData = () => gitData(
  [
    commit('old5', { timestamp: 5, x: 0 }),
    commit('old100', { timestamp: 100, x: 10 }),
    commit('edge', { timestamp: BASE, x: 130 }),
    commit('mid', { timestamp: BASE + 12 * 3600, x: 170 }),
    commit('tip', { timestamp: BASE + DAY, x: 210 }),
  ],
  [lane('main', 0)],
);

// --- tests ----------------------------------------------------------------

describe('applyDateRange', () => {
  it("'all' returns the same reference (downstream memo identity)", () => {
    const data = presetData();
    expect(applyDateRange(data, { kind: 'all' })).toBe(data);
  });

  it('preset anchors at the newest loaded timestamp: [anchor - days*86400, anchor], closed', () => {
    // anchor = tip (BASE + DAY); window [BASE, BASE + DAY]. 'edge' sits at
    // exactly BASE and stays (closed left edge); the ancient commits drop.
    const out = applyDateRange(presetData(), lastDay);
    expect(out.commits.map(c => c.id)).toEqual(['edge', 'mid', 'tip']);
  });

  it('custom window is inclusive: commits exactly on start and end both stay', () => {
    const data = gitData(
      [
        commit('c100', { timestamp: 100 }),
        commit('c200', { timestamp: 200 }),
        commit('c300', { timestamp: 300 }),
        commit('c400', { timestamp: 400 }),
      ],
      [lane('main', 0)],
    );
    const out = applyDateRange(data, { kind: 'custom', start: 200, end: 300 });
    expect(out.commits.map(c => c.id)).toEqual(['c200', 'c300']);
  });

  it('x is purely shifted: minX becomes 0, pairwise x differences unchanged', () => {
    const out = applyDateRange(presetData(), lastDay);
    const x = new Map(out.commits.map(c => [c.id, c.x]));
    expect(Math.min(...x.values())).toBe(0);
    expect(x.get('edge')).toBe(0); // was 130 (the visible minX), now 0
    expect(x.get('mid')).toBe(40); // was 170: 170 - 130
    expect(x.get('tip')).toBe(80); // was 210: 210 - 130
    // px density survives: same deltas as before the shift
    expect(x.get('tip')! - x.get('mid')!).toBe(210 - 170);
    expect(x.get('tip')! - x.get('edge')!).toBe(210 - 130);
  });

  it('time_gaps clip to the visible x span then shift; outside ones drop; t fields stay original', () => {
    const gaps: TimeGap[] = [
      { t_start: 1, t_end: 2, x_start: 50, x_end: 180 },  // straddles left edge 130
      { t_start: 3, t_end: 4, x_start: 180, x_end: 300 }, // straddles right edge 210
      { t_start: 5, t_end: 6, x_start: 10, x_end: 40 },   // fully left of the span
    ];
    const data = gitData(presetData().commits, [lane('main', 0)], { time_gaps: gaps });
    const out = applyDateRange(data, lastDay);
    // [50,180] clips to [130,180] -> shift -> [0,50]; [180,300] clips to
    // [180,210] -> [50,80]; [10,40] clips to width <= 0 -> dropped. The two
    // survivors keep their ORIGINAL t fields (the ruler's inGap check reads
    // time, which still describes the gap's true temporal span).
    expect(out.time_gaps).toEqual([
      { t_start: 1, t_end: 2, x_start: 0, x_end: 50 },
      { t_start: 3, t_end: 4, x_start: 50, x_end: 80 },
    ]);
    // no-gap data takes the same path without crashing (every other fixture
    // here defaults time_gaps to [])
    expect(applyDateRange(presetData(), lastDay).time_gaps).toEqual([]);
  });

  it('edges survive iff both endpoints survive', () => {
    const edges: CommitEdge[] = [
      { from: 'edge', to: 'mid', edge_type: 'Direct' },    // both in: kept
      { from: 'mid', to: 'tip', edge_type: 'Branch' },     // both in: kept
      { from: 'edge', to: 'old100', edge_type: 'Merge' },  // one end out: dropped
      { from: 'old100', to: 'old5', edge_type: 'Direct' }, // both out: dropped
    ];
    const data = gitData(presetData().commits, [lane('main', 0)], { edges });
    const out = applyDateRange(data, lastDay);
    expect(out.edges).toEqual([
      { from: 'edge', to: 'mid', edge_type: 'Direct' },
      { from: 'mid', to: 'tip', edge_type: 'Branch' },
    ]);
  });
});

describe('emptyLaneDead', () => {
  it('zero-commit non-tag lanes die (merged_into -> archived, else dormant); fed lanes and tag lanes stay out', () => {
    const data = gitData(
      [
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: BASE + DAY }),
        commit('qm1', { lane: 1, lane_owner: 'quietmerged', timestamp: 5 }),
        commit('qs1', { lane: 2, lane_owner: 'quietsolo', timestamp: 5 }),
      ],
      [
        lane('main', 0),
        lane('quietmerged', 1, { merged_into: 'm1' }),
        lane('quietsolo', 2),
        lane('v1.0', 3, { is_tag: true }), // zero commits by construction
      ],
    );
    // unfiltered: every non-tag lane owns commits; only the tag lane is
    // empty and it must not count -> empty map
    expect(emptyLaneDead(data).dead.size).toBe(0);
    // after the 1-day window the two quiet lanes lost their only commits
    const out = emptyLaneDead(applyDateRange(data, lastDay));
    expect(out.dead).toEqual(new Map([['quietmerged', 'archived'], ['quietsolo', 'dormant']]));
    expect(out.groups.archived.map(l => l.name)).toEqual(['quietmerged']);
    expect(out.groups.dormant.map(l => l.name)).toEqual(['quietsolo']);
  });

  it('expandedDead lanes leave dead but stay in groups (panel shows them checked)', () => {
    const data = gitData(
      [
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: BASE + DAY }),
        commit('qs1', { lane: 2, lane_owner: 'quietsolo', timestamp: 5 }),
      ],
      [lane('main', 0), lane('quietsolo', 2)],
    );
    const out = emptyLaneDead(applyDateRange(data, lastDay), new Set(['quietsolo']));
    expect(out.dead.size).toBe(0); // back on the canvas as an empty row
    expect(out.groups.dormant.map(l => l.name)).toEqual(['quietsolo']);
  });
});

describe('outOfRangeIds', () => {
  it("'all' -> empty set; preset -> exactly the ids applyDateRange dropped", () => {
    const data = presetData();
    expect(outOfRangeIds(data, { kind: 'all' })).toEqual(new Set());
    const out = outOfRangeIds(data, lastDay);
    expect(out).toEqual(new Set(['old5', 'old100']));
    // consistency with applyDateRange: out-of-range is the exact complement
    // of the kept set, id by id
    const kept = new Set(applyDateRange(data, lastDay).commits.map(c => c.id));
    for (const c of data.commits) {
      expect(out.has(c.id)).toBe(!kept.has(c.id));
    }
  });

  it('custom start > end is a defensive empty window: no commits, all ids out of range', () => {
    const data = gitData(presetData().commits, [lane('main', 0)], { has_more: true });
    const upsideDown: DateRange = { kind: 'custom', start: 300, end: 200 };
    const out = applyDateRange(data, upsideDown);
    expect(out.commits).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.time_gaps).toEqual([]);
    expect(out.branches).toBe(data.branches); // passed through untouched
    expect(out.has_more).toBe(true);
    expect(outOfRangeIds(data, upsideDown))
      .toEqual(new Set(['old5', 'old100', 'edge', 'mid', 'tip']));
  });
});
