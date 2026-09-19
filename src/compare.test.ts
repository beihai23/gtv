import { describe, it, expect } from 'vitest';
import { nextPair, headToLaneTip } from './compare';
import type { BranchLane, CommitNode, GitData } from './types';

// --- fixtures (related.test.ts style; head_branch: null is the required
// GitData mirror field since Task 2, detached semantics) --------------------

function lane(name: string, index: number, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: index, color: '#123456', is_tag: false,
    fork_point: null, merged_into: null, is_active: true, ...over,
  };
}

function commit(
  id: string,
  laneIndex: number,
  laneOwner: string,
  over: Partial<CommitNode> = {},
): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: laneOwner, is_head: false, is_key: true,
    additions: 0, deletions: 0, x: 0, y: 0, lane: laneIndex, ...over,
  };
}

function gitData(commits: CommitNode[], branches: BranchLane[]): GitData {
  return {
    commits, edges: [], branches, main_branch: 'main', time_gaps: [],
    has_more: false, head_branch: null, head_commit_count: null,
  };
}

// --- nextPair --------------------------------------------------------------

describe('nextPair', () => {
  it('null pair: the clicked commit becomes the new base, target cleared', () => {
    expect(nextPair(null, 'a1')).toEqual({ base: 'a1', target: '' });
  });

  it('half-selected: the clicked commit fills the empty target slot', () => {
    expect(nextPair({ base: 'a1', target: '' }, 'b2')).toEqual({ base: 'a1', target: 'b2' });
  });

  it('complete pair: the clicked commit restarts as the new base', () => {
    expect(nextPair({ base: 'a1', target: 'b2' }, 'c3')).toEqual({ base: 'c3', target: '' });
  });

  it('half-selected click on the base itself pins base === target (empty diff, honest)', () => {
    // spec 5: same commit on both sides is allowed -- no special-casing
    expect(nextPair({ base: 'a1', target: '' }, 'a1')).toEqual({ base: 'a1', target: 'a1' });
  });
});

// --- headToLaneTip ---------------------------------------------------------

describe('headToLaneTip', () => {
  it('base = HEAD commit id, target = lane tip id (highest x, not list order)', () => {
    const data = gitData(
      [
        commit('m1', 0, 'main'),
        commit('h1', 0, 'main', { is_head: true, x: 10 }),
        commit('f1', 1, 'feat', { x: 9 }), // lane tip: highest x, listed FIRST
        commit('f2', 1, 'feat', { x: 5 }),
      ],
      [lane('main', 0), lane('feat', 1, { fork_point: 'm1' })],
    );
    // f2 is the LAST feat commit in list order -- a list-order tip rule
    // would pick it; only the highest-x rule yields f1.
    expect(headToLaneTip(data, 'feat')).toEqual({ base: 'h1', target: 'f1' });
  });

  it('HEAD absent from the loaded commits -> null (windowed/paged out)', () => {
    const data = gitData(
      [commit('f1', 1, 'feat'), commit('f2', 1, 'feat', { x: 5 })], // no is_head
      [lane('main', 0), lane('feat', 1, { fork_point: 'm1' })],
    );
    expect(headToLaneTip(data, 'feat')).toBeNull();
  });

  it('unknown lane -> null (defensive, even with a stray same-named lane_owner)', () => {
    // 'ghost' owns a commit but has no branch lane: the branches registry is
    // the existence oracle, so this stays null rather than pairing.
    const data = gitData(
      [commit('h1', 0, 'main', { is_head: true }), commit('g1', 1, 'ghost', { x: 5 })],
      [lane('main', 0)],
    );
    expect(headToLaneTip(data, 'ghost')).toBeNull();
  });

  it('lane with no loaded commits -> null (tip outside the window)', () => {
    const data = gitData(
      [commit('h1', 0, 'main', { is_head: true })],
      [lane('main', 0), lane('feat', 1, { fork_point: 'm1' })],
    );
    expect(headToLaneTip(data, 'feat')).toBeNull();
  });
});
