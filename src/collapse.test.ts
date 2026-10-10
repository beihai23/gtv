import { describe, it, expect } from 'vitest';
import { collapsedRuns } from './collapse';
import type { BranchLane, CommitNode } from './types';

// --- fixtures (compare.test.ts style) ---------------------------------------

function lane(name: string, index: number, color = '#123456'): BranchLane {
  return {
    name, lane_index: index, color, is_tag: false,
    fork_point: null, merged_into: null, is_active: true,
  };
}

function commit(
  id: string,
  x: number,
  over: Partial<CommitNode> = {},
): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: 'feature', is_head: false, is_key: false,
    additions: 0, deletions: 0, x, y: 0, lane: 2, ...over,
  };
}

const NO_HIDDEN = new Set<string>();
const NO_LANES = new Set<string>();
const NO_IDS = new Set<string>();

describe('collapsedRuns', () => {
  it('one folded stretch yields ONE chip for the whole run', () => {
    const commits = [
      commit('k0', 0, { is_key: true }),
      commit('a', 10),
      commit('b', 20),
      commit('c', 30),
      commit('k1', 40, { is_key: true }),
    ];
    const runs = collapsedRuns(commits, [lane('feature', 2, '#AABBCC')], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs).toHaveLength(1);
    expect(runs[0].ids).toEqual(['a', 'b', 'c']);
    expect(runs[0].lane_index).toBe(2);
    expect(runs[0].color).toBe('#AABBCC');
  });

  it('key commits split a lane into separate runs', () => {
    const commits = [
      commit('a', 10),
      commit('k', 20, { is_key: true }),
      commit('b', 30),
      commit('c', 40),
    ];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs.map(r => r.ids)).toEqual([['a'], ['b', 'c']]);
  });

  it('expanding a run (expandedIds) makes it disappear', () => {
    const commits = [commit('a', 10), commit('b', 20), commit('c', 30)];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, NO_LANES, new Set(['a', 'b', 'c']));
    expect(runs).toEqual([]);
  });

  it('an expanded lane yields no chips at all', () => {
    const commits = [commit('a', 10), commit('b', 20)];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, new Set(['feature']), NO_IDS);
    expect(runs).toEqual([]);
  });

  it('chip x is the midpoint of the run ends (sorted by x, not list order)', () => {
    const commits = [commit('b', 40), commit('a', 10), commit('c', 30)];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs).toHaveLength(1);
    expect(runs[0].ids).toEqual(['a', 'c', 'b']);
    expect(runs[0].x).toBe(25); // (10 + 40) / 2
  });

  it('hiddenIds (inactive-lane collapse) never take part', () => {
    const commits = [commit('a', 10), commit('b', 20)];
    const runs = collapsedRuns(commits, [lane('feature', 2)], new Set(['a', 'b']), NO_LANES, NO_IDS);
    expect(runs).toEqual([]);
  });

  it("unattributed commits (lane_owner '') never take part", () => {
    const commits = [commit('a', 10, { lane_owner: '', lane: 0 }), commit('b', 20)];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs.map(r => r.ids)).toEqual([['b']]);
  });

  it('is_key commits never appear inside a run', () => {
    const commits = [
      commit('a', 10),
      commit('k', 15, { is_key: true }),
      commit('b', 20),
    ];
    const runs = collapsedRuns(commits, [lane('feature', 2)], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs.flatMap(r => r.ids)).not.toContain('k');
  });

  it('a lane missing from branches falls back to #666', () => {
    const commits = [commit('a', 10)];
    const runs = collapsedRuns(commits, [], NO_HIDDEN, NO_LANES, NO_IDS);
    expect(runs[0].color).toBe('#666');
  });

  it('lanes are independent: one run per lane', () => {
    const commits = [
      commit('a', 10),
      commit('m', 12, { lane_owner: 'main', lane: 0 }),
    ];
    const runs = collapsedRuns(
      commits,
      [lane('main', 0, '#000'), lane('feature', 2, '#FFF')],
      NO_HIDDEN, NO_LANES, NO_IDS,
    );
    expect(runs).toHaveLength(2);
    const main = runs.find(r => r.lane_index === 0)!;
    const feat = runs.find(r => r.lane_index === 2)!;
    expect(main.ids).toEqual(['m']);
    expect(feat.ids).toEqual(['a']);
  });
});
