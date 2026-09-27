//! Pure-graph tests for the lane propagation algorithm — 1:1 port of
//! src-tauri/tests/layout_pure.rs. Fixtures are hand-built CommitNode
//! graphs; no git repo involved.

import { describe, expect, it } from 'vitest';
import type { BranchLane, BranchRef, CommitEdge, CommitNode } from '../../../src/types';

type EdgeType = CommitEdge['edge_type'];
import {
  computeLayout,
  LANE_PALETTE,
  laneColor,
  MAIN_COLOR,
  type LaneSeed,
} from './layout';

function commit(id: string, ts: number, parents: string[]): CommitNode {
  return {
    id,
    short_id: id.slice(0, Math.min(7, id.length)),
    message: `commit ${id}`,
    author_name: 'test',
    author_email: 't@t',
    timestamp: ts,
    parents: [...parents],
    branch_refs: [],
    fork_branch_name: null,
    merge_branch_name: null,
    lane_owner: '',
    is_head: false,
    is_key: false,
    additions: 0,
    deletions: 0,
    x: 0,
    y: 0,
    lane: 0,
  };
}

function seed(name: string, tip: string): LaneSeed {
  return { name, tip };
}

function laneOf(commits: CommitNode[], id: string): string {
  const c = commits.find((c) => c.id === id);
  if (!c) throw new Error(`commit ${id} not found`);
  return c.lane_owner;
}

function lane(lanes: BranchLane[], name: string): BranchLane {
  const l = lanes.find((l) => l.name === name);
  if (!l) throw new Error(`lane ${name} not found`);
  return l;
}

const EDGE_ORDER: Record<EdgeType, number> = { Direct: 0, Branch: 1, Merge: 2 };

function edgeTypes(edges: CommitEdge[], from: string): EdgeType[] {
  return edges
    .filter((e) => e.from === from)
    .map((e) => e.edge_type)
    .sort((a, b) => EDGE_ORDER[a] - EDGE_ORDER[b]);
}

function findCommit(commits: CommitNode[], id: string): CommitNode {
  const c = commits.find((c) => c.id === id);
  if (!c) throw new Error(`commit ${id} not found`);
  return c;
}

describe('laneColor', () => {
  it('fixes lane 0 to MAIN_COLOR and rotates the palette', () => {
    expect(laneColor(0)).toBe(MAIN_COLOR);
    expect(laneColor(-1)).toBe(MAIN_COLOR);
    expect(laneColor(1)).toBe(LANE_PALETTE[0]);
    expect(laneColor(LANE_PALETTE.length)).toBe(LANE_PALETTE[LANE_PALETTE.length - 1]);
    // palette wraps around
    expect(laneColor(LANE_PALETTE.length + 1)).toBe(LANE_PALETTE[0]);
  });
});

describe('computeLayout', () => {
  it('linear_history_single_lane', () => {
    const commits = [
      commit('c1', 100, []),
      commit('c2', 200, ['c1']),
      commit('c3', 300, ['c2']),
    ];
    const { lanes, edges } = computeLayout(commits, [seed('main', 'c3')], 'main', 'c3');

    expect(lanes.length).toBe(1);
    for (const c of commits) {
      expect(c.lane_owner).toBe('main');
      expect(c.lane).toBe(0);
    }
    expect(edges.every((e) => e.edge_type === 'Direct')).toBe(true);
    expect(findCommit(commits, 'c3').is_head).toBe(true);
  });

  it('feature_branch_fork_and_merge', () => {
    // main:   c1 -- c2 ------- m1
    //                 \       /
    // feat:            f1 -- f2
    const commits = [
      commit('c1', 100, []),
      commit('c2', 200, ['c1']),
      commit('f1', 300, ['c2']),
      commit('f2', 400, ['f1']),
      commit('m1', 500, ['c2', 'f2']),
    ];
    const seeds = [seed('main', 'm1'), seed('feat', 'f2')];
    const { lanes, edges } = computeLayout(commits, seeds, 'main', 'm1');

    expect(laneOf(commits, 'c1')).toBe('main');
    expect(laneOf(commits, 'c2')).toBe('main');
    expect(laneOf(commits, 'm1')).toBe('main');
    expect(laneOf(commits, 'f1')).toBe('feat');
    expect(laneOf(commits, 'f2')).toBe('feat');

    const feat = lane(lanes, 'feat');
    expect(feat.fork_point).toBe('c2');
    expect(feat.merged_into).toBe('m1');
    expect(feat.lane_index).toBe(1);

    // fork annotation lands on the fork-point commit (parent lane)
    expect(findCommit(commits, 'c2').fork_branch_name).toBe('feat');
    // merge annotation lands on the merge commit
    expect(findCommit(commits, 'm1').merge_branch_name).toBe('feat');

    // edge types: f1->c2 is Branch, m1->f2 is Merge, m1->c2 Direct
    expect(
      edges.some((e) => e.from === 'f1' && e.to === 'c2' && e.edge_type === 'Branch'),
    ).toBe(true);
    expect(
      edges.some((e) => e.from === 'm1' && e.to === 'f2' && e.edge_type === 'Merge'),
    ).toBe(true);
    expect(
      edges.some((e) => e.from === 'm1' && e.to === 'c2' && e.edge_type === 'Direct'),
    ).toBe(true);
  });

  it('unmerged_branch_reaches_tip_without_merge_edge', () => {
    // main:  c1 -- c2
    //          \
    // feat:     f1 (tip, never merged)
    const commits = [
      commit('c1', 100, []),
      commit('c2', 200, ['c1']),
      commit('f1', 250, ['c1']),
    ];
    const seeds = [seed('main', 'c2'), seed('feat', 'f1')];
    const { lanes, edges } = computeLayout(commits, seeds, 'main', 'c2');

    expect(laneOf(commits, 'f1')).toBe('feat');
    expect(lane(lanes, 'feat').merged_into).toBeNull();
    expect(edges.some((e) => e.edge_type === 'Merge')).toBe(false);
  });

  it('branch_forked_from_another_branch', () => {
    // main:  c1
    //          \
    // base:     b1
    //             \
    // sub:         s1
    const commits = [
      commit('c1', 100, []),
      commit('b1', 200, ['c1']),
      commit('s1', 300, ['b1']),
    ];
    const seeds = [seed('main', 'c1'), seed('base', 'b1'), seed('sub', 's1')];
    const { lanes } = computeLayout(commits, seeds, 'main', null);

    expect(laneOf(commits, 'b1')).toBe('base');
    expect(laneOf(commits, 's1')).toBe('sub');
    expect(lane(lanes, 'sub').fork_point).toBe('b1');
    // fork annotation for "sub" lands on b1 (on the "base" lane)
    expect(findCommit(commits, 'b1').fork_branch_name).toBe('sub');
  });

  it('octopus_merge_produces_one_merge_edge_per_extra_parent', () => {
    // main:  c1 -------- m1
    //         \  \      /  /
    // a:       a1 -----   /
    // b:        \ b1 -----
    const commits = [
      commit('c1', 100, []),
      commit('a1', 200, ['c1']),
      commit('b1', 250, ['c1']),
      commit('m1', 300, ['c1', 'a1', 'b1']),
    ];
    const seeds = [seed('main', 'm1'), seed('a', 'a1'), seed('b', 'b1')];
    const { lanes, edges } = computeLayout(commits, seeds, 'main', null);

    const mergeEdges = edges.filter((e) => e.from === 'm1' && e.edge_type === 'Merge');
    expect(mergeEdges.length).toBe(2);
    expect(lane(lanes, 'a').merged_into).toBe('m1');
    expect(lane(lanes, 'b').merged_into).toBe('m1');
  });

  it('compression_marks_only_key_commits', () => {
    // main:  c1 -- c2 -- c3 -- c4(tip)
    //               \
    // feat:          f1 -- f2(tip, unmerged)
    // c3 is the only "boring" commit: no refs, no merge, same-lane parent
    // and child — it must NOT survive compression. Everything else is key.
    const commits = [
      commit('c1', 100, []),
      commit('c2', 200, ['c1']),
      commit('c3', 300, ['c2']),
      commit('c4', 400, ['c3']),
      commit('f1', 250, ['c2']),
      commit('f2', 350, ['f1']),
    ];
    const seeds = [seed('main', 'c4'), seed('feat', 'f2')];
    computeLayout(commits, seeds, 'main', 'c4');

    const key = (id: string) => findCommit(commits, id).is_key;
    expect(key('c1')).toBe(true); // root = lane birth
    expect(key('c2')).toBe(true); // fork point
    expect(key('c4')).toBe(true); // lane tip + HEAD
    expect(key('f1')).toBe(true); // lane birth
    expect(key('f2')).toBe(true); // lane tip
    expect(key('c3')).toBe(false); // boring middle commit must be compressed
  });

  it('lanes_sorted_by_birth_time', () => {
    // old forks sit closer to main (lane 1), late forks further out.
    // main:  c1 -- c2 -- c3
    //          \      \
    // early:    e1     \
    // late:             l1
    const commits = [
      commit('c1', 100, []),
      commit('e1', 150, ['c1']),
      commit('c2', 200, ['c1']),
      commit('c3', 300, ['c2']),
      commit('l1', 350, ['c3']),
    ];
    const seeds = [seed('main', 'c3'), seed('early', 'e1'), seed('late', 'l1')];
    const { lanes } = computeLayout(commits, seeds, 'main', null);

    expect(lane(lanes, 'early').lane_index).toBe(1);
    expect(lane(lanes, 'late').lane_index).toBe(2);
  });

  it('anomalous_time_gap_is_folded', () => {
    // Two clusters 400 days apart: the empty range must collapse to ~120px
    // with one TimeGap recorded, instead of stretching the scene by 4000px.
    // (Commits inside a cluster sit 10 days apart so the 10px/day time scale
    // exceeds the 28px per-lane minimum spacing. a2/b1 are tagged to make
    // them key: the min-spacing cascade runs over key commits only, and
    // non-key commits get interpolated x positions instead.)
    const day = 86400;
    const commits = [
      commit('a1', 100 * day, []),
      commit('a2', 110 * day, ['a1']),
      commit('b1', 510 * day, ['a2']),
      commit('b2', 520 * day, ['b1']),
    ];
    for (const id of ['a2', 'b1']) {
      findCommit(commits, id).branch_refs.push({
        name: `tag-${id}`,
        is_remote: false,
        is_tag: true,
        color: '',
      });
    }
    const { timeGaps } = computeLayout(commits, [seed('main', 'b2')], 'main', 'b2');

    expect(timeGaps.length).toBe(1); // one folded gap expected
    const g = timeGaps[0];
    expect(g.t_start).toBeGreaterThanOrEqual(100 * day);
    expect(g.t_end).toBeLessThanOrEqual(520 * day);
    expect(Math.abs(g.x_end - g.x_start - 120.0)).toBeLessThan(1e-6);

    const xOf = (id: string) => findCommit(commits, id).x;
    // Commits left of the gap keep their x; commits right of it are shifted
    // so the on-screen distance across the gap is exactly the folded width.
    expect(Math.abs(xOf('b1') - xOf('a2') - 120.0)).toBeLessThan(1e-6);
    // Normal spacing inside each cluster is preserved.
    expect(Math.abs(xOf('a2') - xOf('a1') - 100.0)).toBeLessThan(1e-6);
    expect(Math.abs(xOf('b2') - xOf('b1') - 100.0)).toBeLessThan(1e-6);
  });

  it('small_time_gap_is_not_folded', () => {
    // 10 days apart (100px) — below the 45-day threshold, no folding.
    const day = 86400;
    const commits = [commit('a1', 100 * day, []), commit('a2', 110 * day, ['a1'])];
    const { timeGaps } = computeLayout(commits, [seed('main', 'a2')], 'main', 'a2');
    expect(timeGaps.length).toBe(0);
    const xOf = (id: string) => findCommit(commits, id).x;
    expect(Math.abs(xOf('a2') - xOf('a1') - 100.0)).toBeLessThan(1e-6);
  });

  it('same_second_commits_order_topologically', () => {
    // A rebase rewrites a whole branch in one second: every commit gets
    // the SAME committer timestamp. The layout must still order the
    // chain parent→child left→right (the walk feeds newest-first, so a
    // plain stable sort would invert the tie group) and no two commits
    // may share an x (they would render as one stacked blob).
    // Input is intentionally newest-first, mimicking the revwalk order.
    const base = 1_000_000;
    const commits = [
      commit('r5', base, ['r4']),
      commit('r4', base, ['r3']),
      commit('r3', base, ['r2']),
      commit('r2', base, ['r1']),
      commit('r1', base, ['m1']),
      commit('m1', base - 86400, []),
    ];
    const { lanes } = computeLayout(
      commits,
      [seed('feat', 'r5'), seed('main', 'm1')],
      'main',
      'm1',
    );

    const xOf = (id: string) => findCommit(commits, id).x;
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
    for (let w = 0; w + 1 < ids.length; w++) {
      expect(
        xOf(ids[w]),
        `parent ${ids[w]} must sit left of child ${ids[w + 1]}`,
      ).toBeLessThan(xOf(ids[w + 1]));
    }
    // All five belong to the feat lane and sit right of the fork point.
    expect(lane(lanes, 'feat').fork_point).toBe('m1');
    for (const id of ids) {
      expect(laneOf(commits, id)).toBe('feat');
      expect(xOf(id)).toBeGreaterThan(xOf('m1'));
    }
  });

  /// A ref-carrying commit no seed claimed (its branch is deselected in the
  /// branch panel, but it entered the window through a merge from a selected
  /// lane) must NOT be absorbed by the fake-main fallback — it renders
  /// unattributed (""), and its unclaimed first-parent ancestry travels with
  /// it instead of splitting onto the fallback lane.
  it('unselected_ref_tip_is_unattributed_not_absorbed', () => {
    const withRefs = (c: CommitNode, names: string[]): CommitNode => {
      c.branch_refs = names.map(
        (n): BranchRef => ({ name: n, is_remote: true, is_tag: false, color: '' }),
      );
      return c;
    };

    //   web:  b1 -> w1 -> w2                     (main_branch stand-in)
    //   pre:  b1 -> ph1 -> pm(merge t2) -> ptip
    //   tran:      b1 -> t1 -> t2 [ref]          (deselected branch)
    const commits = [
      commit('b1', 100, []),
      commit('w1', 110, ['b1']),
      commit('w2', 120, ['w1']),
      commit('ph1', 115, ['b1']),
      commit('pm', 150, ['ph1', 't2']),
      commit('ptip', 160, ['pm']),
      withRefs(commit('t1', 130, ['b1']), []),
      withRefs(commit('t2', 140, ['t1']), ['origin/tran']),
    ];
    // transfi is deselected: only web and pre seed the view. main_branch is
    // "web" — what detect_main_branch yields when main is not selected
    // (seeds.first()).
    const { edges } = computeLayout(
      commits,
      [seed('web', 'w2'), seed('pre', 'ptip')],
      'web',
      'w2',
    );

    expect(laneOf(commits, 't2')).toBe(''); // ref tip must be unattributed
    expect(laneOf(commits, 't1')).toBe(''); // ancestry travels with the tip
    expect(findCommit(commits, 't2').lane).toBe(0);
    expect(findCommit(commits, 't2').is_key).toBe(false);
    expect(laneOf(commits, 'w2')).toBe('web');
    expect(laneOf(commits, 'ptip')).toBe('pre');
    // The merge stays on pre's lane and names the hidden lineage from its refs.
    expect(findCommit(commits, 'pm').merge_branch_name).toBe('tran');
    expect(edgeTypes(edges, 'pm')).toEqual(['Direct', 'Merge']);
  });

  /// Same graph with the branch selected: the tip claims its own lane and the
  /// merge names it — the pre-fix full-view behaviour must be preserved.
  it('selected_ref_tip_claims_its_lane', () => {
    const withRefs = (c: CommitNode, names: string[]): CommitNode => {
      c.branch_refs = names.map(
        (n): BranchRef => ({ name: n, is_remote: true, is_tag: false, color: '' }),
      );
      return c;
    };
    const commits = [
      commit('b1', 100, []),
      commit('w1', 110, ['b1']),
      commit('w2', 120, ['w1']),
      commit('ph1', 115, ['b1']),
      commit('pm', 150, ['ph1', 't2']),
      commit('ptip', 160, ['pm']),
      withRefs(commit('t1', 130, ['b1']), []),
      withRefs(commit('t2', 140, ['t1']), ['origin/tran']),
    ];
    const { lanes } = computeLayout(
      commits,
      [seed('web', 'w2'), seed('pre', 'ptip'), seed('tran', 't2')],
      'web',
      'w2',
    );
    expect(laneOf(commits, 't2')).toBe('tran');
    expect(laneOf(commits, 't1')).toBe('tran');
    expect(lanes.some((l) => l.name === 'tran')).toBe(true);
    expect(findCommit(commits, 'pm').merge_branch_name).toBe('tran');
  });

  /// Anonymous (ref-less) unclaimed lineage is foreign too: it belongs to no
  /// rendered lane and is unattributed (hidden), never painted onto a lane it
  /// was merely merged into.
  it('anonymous_unclaimed_lineage_is_unattributed', () => {
    const commits = [
      commit('b1', 100, []),
      commit('w1', 110, ['b1']),
      commit('m', 130, ['w1', 's1']),
      commit('w2', 140, ['w1']),
      commit('s1', 120, ['b1']),
    ];
    computeLayout(commits, [seed('web', 'w2')], 'web', 'w2');
    expect(laneOf(commits, 's1')).toBe('');
    // No refs on the hidden parent, so the merge node names nothing.
    expect(findCommit(commits, 'm').merge_branch_name).toBeNull();
  });
});
