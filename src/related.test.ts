import { describe, it, expect } from 'vitest';
import { relatedLanes } from './related';
import type { BranchLane, CommitNode, GitData } from './types';

// --- fixtures -------------------------------------------------------------

function lane(name: string, index: number, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: index, color: '#123456', is_tag: false,
    fork_point: null, merged_into: null, is_active: true, ...over,
  };
}

function commit(id: string, laneIndex: number, laneOwner: string): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: laneOwner, is_head: false, is_key: true,
    additions: 0, deletions: 0, x: 0, y: 0, lane: laneIndex,
  };
}

function gitData(commits: CommitNode[], branches: BranchLane[]): GitData {
  return {
    commits, edges: [], branches, main_branch: 'main', time_gaps: [],
    has_more: false,
  };
}

// Master fixture: main <- A <- B on a single fork line; C forks from A too
// (B's sibling); D forks from B and E from D (descendant chain); D merged
// into release, and release itself merged into other (transitivity trap);
// X merged into B (reverse direction, joins); Y merged into A, Z into main
// and W into D (reverse direction into ancestor/base/descendant: stay out).
const master = () => gitData(
  [
    commit('m1', 0, 'main'), commit('m2', 0, 'main'), commit('m3', 0, 'main'),
    commit('a1', 1, 'A'), commit('a2', 1, 'A'),
    commit('b1', 2, 'B'), commit('b2', 2, 'B'), commit('b3', 2, 'B'), commit('b5', 2, 'B'),
    commit('c1', 3, 'C'),
    commit('d1', 4, 'D'), commit('d2', 4, 'D'),
    commit('e1', 5, 'E'),
    commit('r1', 6, 'release'), commit('r2', 6, 'release'),
    commit('x1', 7, 'X'), commit('x2', 7, 'X'),
    commit('o1', 8, 'other'),
    commit('y1', 9, 'Y'), commit('z1', 10, 'Z'), commit('w1', 11, 'W'),
  ],
  [
    lane('main', 0),
    lane('A', 1, { fork_point: 'm2' }),
    lane('B', 2, { fork_point: 'a2' }),
    lane('C', 3, { fork_point: 'a2' }),
    lane('D', 4, { fork_point: 'b3', merged_into: 'r2' }),
    lane('E', 5, { fork_point: 'd2' }),
    lane('release', 6, { fork_point: 'm1', merged_into: 'o1' }),
    lane('X', 7, { fork_point: 'm3', merged_into: 'b5' }),
    lane('other', 8, { fork_point: 'm1' }),
    lane('Y', 9, { fork_point: 'm1', merged_into: 'a1' }), // merged into ancestor A
    lane('Z', 10, { fork_point: 'm1', merged_into: 'm1' }), // merged into main itself
    lane('W', 11, { fork_point: 'm1', merged_into: 'd1' }), // merged into descendant D
  ],
);

// --- tests ----------------------------------------------------------------

describe('relatedLanes', () => {
  it('up-chain is single-line: target + fork ancestors + main', () => {
    const data = gitData(
      [
        commit('m1', 0, 'main'), commit('m2', 0, 'main'),
        commit('a1', 1, 'A'), commit('a2', 1, 'A'),
        commit('b1', 2, 'B'), commit('b2', 2, 'B'),
      ],
      [
        lane('main', 0),
        lane('A', 1, { fork_point: 'm2' }),
        lane('B', 2, { fork_point: 'a2' }),
      ],
    );
    const out = relatedLanes(data, 'B');
    expect(out).toEqual(new Set(['B', 'A', 'main']));
    expect(out.size).toBe(3);
  });

  it('siblings (same fork parent, off the chain) are excluded', () => {
    expect(relatedLanes(master(), 'B').has('C')).toBe(false);
  });

  it('fork descendants join transitively (BFS down from the target)', () => {
    const out = relatedLanes(master(), 'B');
    expect(out.has('D')).toBe(true);
    expect(out.has('E')).toBe(true);
  });

  it('merge targets join one hop; a merge target of a merge target does not', () => {
    const out = relatedLanes(master(), 'B');
    expect(out.has('release')).toBe(true); // D merged into r2 on release
    expect(out.has('other')).toBe(false); // release merged into other: no transitivity
  });

  it('lanes merged INTO the target are blood too (reverse direction)', () => {
    expect(relatedLanes(master(), 'B').has('X')).toBe(true); // X merged into b5 on B
  });

  it('reverse-merge inclusion is target-only: ancestor, main and descendant merges stay out', () => {
    const out = relatedLanes(master(), 'B');
    expect(out.has('X')).toBe(true); // merged into B itself: blood
    expect(out.has('Y')).toBe(false); // merged into A, an ancestor of B
    expect(out.has('Z')).toBe(false); // merged into main -- on real repos everything merges into main
    expect(out.has('W')).toBe(false); // merged into D, a descendant of B
  });

  it('full closure of the master fixture is exactly the 7 blood lanes', () => {
    // core {B, A, main, D, E} + release (D's merge target) + X (merged into
    // B itself); sibling C and reverse traps Y/Z/W stay out
    expect(relatedLanes(master(), 'B'))
      .toEqual(new Set(['B', 'A', 'main', 'D', 'E', 'release', 'X']));
  });

  it('unresolvable fork_point truncates the up-chain; main always stays', () => {
    const data = gitData(
      [
        commit('m1', 0, 'main'),
        commit('b1', 2, 'B'), commit('b2', 2, 'B'),
        commit('d1', 4, 'D'),
      ],
      [
        lane('main', 0),
        lane('B', 2, { fork_point: 'missing-parent-oid' }), // outside loaded commits
        lane('D', 4, { fork_point: 'b1' }),
      ],
    );
    const out = relatedLanes(data, 'B');
    expect(out.has('main')).toBe(true);
    expect(out).toEqual(new Set(['B', 'D', 'main']));
  });

  it('closure is idempotent on the trimmed branch subset', () => {
    // Mirrors the real consumer: filter_by_branches rebuilds the view with
    // re-indexed lanes and only the kept lanes' commits.
    const data = master();
    const keep = relatedLanes(data, 'B');
    const remap = new Map<number, number>();
    const branches = data.branches
      .filter(b => keep.has(b.name))
      .map((b, i) => { remap.set(b.lane_index, i); return { ...b, lane_index: i }; });
    const commits = data.commits
      .filter(c => remap.has(c.lane))
      .map(c => ({ ...c, lane: remap.get(c.lane)! }));
    expect(relatedLanes({ ...data, commits, branches }, 'B')).toEqual(keep);
  });

  it('unknown target degrades to a main-only set', () => {
    const out = relatedLanes(master(), 'ghost');
    expect(out).toEqual(new Set(['main']));
    expect(out.size).toBe(1);
  });

  it('tag pseudo-lanes never take part (even forked from the target)', () => {
    const data = gitData(
      [commit('m1', 0, 'main'), commit('b1', 2, 'B'), commit('b2', 2, 'B')],
      [
        lane('main', 0),
        lane('B', 2, { fork_point: 'm1' }),
        lane('v1.0', 3, { is_tag: true, fork_point: 'b2' }),
      ],
    );
    expect(relatedLanes(data, 'B')).toEqual(new Set(['B', 'main']));
  });
});
