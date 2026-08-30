import { describe, it, expect } from 'vitest';
import { computeInactive, collapseLanes, DeadKind, LANE_HEIGHT } from './inactive';
import type { BranchLane, CommitNode, GitData } from './types';

// --- fixtures -------------------------------------------------------------

export function lane(name: string, index: number, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: index, color: '#123456', is_tag: false,
    fork_point: null, merged_into: null, is_active: true, ...over,
  };
}

export function commit(id: string, over: Partial<CommitNode> = {}): CommitNode {
  return {
    id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
    timestamp: 1000, parents: [], branch_refs: [], fork_branch_name: null,
    merge_branch_name: null, lane_owner: '', is_head: false, is_key: true,
    additions: 0, deletions: 0, x: 0, y: 0, lane: 0, ...over,
  };
}

const NOW = 1_000_000_000;
const d = (days: number) => NOW - days * 86400;

function gitData(commits: CommitNode[], branches: BranchLane[]): GitData {
  return {
    commits, edges: [], branches, main_branch: 'main', time_gaps: [],
    has_more: false, head_branch: null,
  };
}

// --- tests ----------------------------------------------------------------

describe('computeInactive', () => {
  it('LANE_HEIGHT is pinned to the backend layout constant (src-tauri layout.rs: 80.0)', () => {
    expect(LANE_HEIGHT).toBe(80);
  });

  it('threshold 0 disables collapsing entirely', () => {

    const info = computeInactive(gitData([], [lane('x', 0)]), 0, new Set(), NOW);
    expect(info.dead.size).toBe(0);
    expect(info.groups.archived).toHaveLength(0);
    expect(info.groups.dormant).toHaveLength(0);
  });

  it('merged + quiet lane is archived; unmerged + quiet is dormant', () => {
    const data = gitData(
      [
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) }),
        commit('a1', { lane: 1, lane_owner: 'oldfeat', timestamp: d(200) }),
        commit('u1', { lane: 2, lane_owner: 'wip', timestamp: d(200) }),
      ],
      [
        lane('main', 0),
        lane('oldfeat', 1, { merged_into: 'm1' }),
        lane('wip', 2),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('oldfeat')).toBe('archived');
    expect(info.dead.get('wip')).toBe('dormant');
    expect(info.groups.archived.map(l => l.name)).toEqual(['oldfeat']);
    expect(info.groups.dormant.map(l => l.name)).toEqual(['wip']);
  });

  it('fresh lanes stay regardless of merge state', () => {
    const data = gitData(
      [
        commit('a1', { lane: 1, lane_owner: 'recentfeat', timestamp: d(10), }),
      ],
      [lane('recentfeat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('recentfeat')).toBe(false);
  });

  it('boundary: tip exactly at the cutoff stays active', () => {
    const data = gitData(
      [commit('a1', { lane: 1, lane_owner: 'edge', timestamp: d(90) })],
      [lane('edge', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('edge')).toBe(false);
  });

  it('protected exact names never collapse (even quiet and merged)', () => {
    const data = gitData(
      [commit('u1', { lane: 1, lane_owner: 'uat', timestamp: d(500) })],
      [lane('uat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('uat')).toBe(false);
  });

  it('protection is exact-name: feature/dev is NOT dev', () => {
    const data = gitData(
      [commit('f1', { lane: 1, lane_owner: 'feature/dev', timestamp: d(500) })],
      [lane('feature/dev', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('feature/dev')).toBe('archived');
  });

  it('fork-parent closure keeps ancestors of active lanes', () => {
    // active feature forked from old release/v1 -> v1 is load-bearing
    const data = gitData(
      [
        commit('r1', { id: 'r1', lane: 1, lane_owner: 'release/v1', timestamp: d(400), x: 10 }),
        commit('f1', { lane: 2, lane_owner: 'feat', timestamp: d(5), parents: ['r1'] }),
      ],
      [
        lane('release/v1', 1, { fork_point: 'root' }),
        lane('feat', 2, { fork_point: 'r1' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('feat')).toBe(false);
    expect(info.dead.has('release/v1')).toBe(false);
  });

  it('closure walks through already-active parents (grandparent kept)', () => {
    // feat(active) -> forked from dev(active) -> forked from base(quiet, merged)
    const data = gitData(
      [
        commit('b1', { lane: 1, lane_owner: 'base', timestamp: d(400), x: 10 }),
        commit('d1', { lane: 2, lane_owner: 'dev', timestamp: d(20), x: 20 }),
        commit('f1', { lane: 3, lane_owner: 'feat', timestamp: d(5), x: 30 }),
      ],
      [
        lane('base', 1, { merged_into: 'm0', fork_point: 'root' }),
        lane('dev', 2, { fork_point: 'b1' }),
        lane('feat', 3, { fork_point: 'd1' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('base')).toBe(false);
  });

  it('dead lanes with dead dependents still collapse (no live descendant)', () => {
    // dead2 forked from dead1, both quiet -> both dead
    const data = gitData(
      [
        commit('d1c', { lane: 1, lane_owner: 'dead1', timestamp: d(400), x: 10 }),
        commit('d2c', { lane: 2, lane_owner: 'dead2', timestamp: d(300), x: 20 }),
      ],
      [
        lane('dead1', 1, { merged_into: 'm0' }),
        lane('dead2', 2, { fork_point: 'd1c' }),
      ],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('dead1')).toBe('archived');
    expect(info.dead.get('dead2')).toBe('dormant');
  });

  it('tag pseudo-lanes never take part', () => {
    const data = gitData(
      [commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) })],
      [lane('v1.0', 5, { is_tag: true })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('v1.0')).toBe(false);
  });

  it('lanes with no loaded commits are skipped (not dead, not grouped)', () => {
    const data = gitData(
      [commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1) })],
      [lane('main', 0), lane('ghost', 3, { merged_into: 'm1' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.has('ghost')).toBe(false);
    expect(info.groups.archived).toHaveLength(0);
  });

  it('expandedDead lanes are excluded from dead but stay in groups', () => {
    const data = gitData(
      [commit('a1', { lane: 1, lane_owner: 'oldfeat', timestamp: d(200) })],
      [lane('oldfeat', 1, { merged_into: 'm0' })],
    );
    const info = computeInactive(data, 90, new Set(['oldfeat']), NOW);
    expect(info.dead.has('oldfeat')).toBe(false);
    expect(info.groups.archived.map(l => l.name)).toEqual(['oldfeat']);
  });

  it('lane with no own commits falls back to its ref target timestamp', () => {
    // release/v1.x-style lanes: the ref sits on a commit owned by another
    // lane, so the lane itself has zero loaded commits. Without the ref
    // fallback these escape collapsing (and defeat the acceptance fixture).
    const data = gitData(
      [
        commit('m0', {
          lane: 0, lane_owner: 'main', timestamp: d(300), x: 10,
          branch_refs: [{ name: 'old-rel', is_remote: false, is_tag: false, color: '#000' }],
        }),
        commit('m1', { lane: 0, lane_owner: 'main', timestamp: d(1), x: 20 }),
      ],
      [lane('main', 0), lane('old-rel', 1, { merged_into: 'm1' })],
    );
    const info = computeInactive(data, 90, new Set(), NOW);
    expect(info.dead.get('old-rel')).toBe('archived');
  });
});

describe('collapseLanes', () => {
  const mk = () => gitData(
    [
      commit('m1', { lane: 0, lane_owner: 'main', x: 100, y: 0 }),
      commit('m2', { lane: 0, lane_owner: 'main', x: 200, y: 0 }),
      commit('a1', { lane: 1, lane_owner: 'arch1', x: 150, y: LANE_HEIGHT }),
      commit('a2', { lane: 1, lane_owner: 'arch1', x: 170, y: LANE_HEIGHT }),
      commit('u1', { lane: 2, lane_owner: 'dorm1', x: 180, y: LANE_HEIGHT * 2 }),
      commit('k1', { lane: 3, lane_owner: 'keep1', x: 220, y: LANE_HEIGHT * 3 }),
    ],
    [
      lane('main', 0),
      lane('arch1', 1, { merged_into: 'm2', color: '#aa0000' }),
      lane('dorm1', 2, { color: '#00aa00' }),
      lane('keep1', 3, { color: '#0000aa' }),
    ],
  );

  it('empty dead map returns the original data object', () => {
    const data = mk();
    expect(collapseLanes(data, new Map()).data).toBe(data);
  });

  it('compacts active lanes to hole-free rows, appends two trace rows', () => {
    const dead: Map<string, DeadKind> = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const byName = new Map(v.data.branches.map(b => [b.name, b.lane_index]));
    expect(byName.get('main')).toBe(0);
    expect(byName.get('keep1')).toBe(1); // compacted, no hole
    const rows = v.traceRows.map(r => r.kind);
    expect(rows).toEqual(['archived', 'dormant']);
    expect(v.traceRows[0].laneIndex).toBe(2);
    expect(v.traceRows[1].laneIndex).toBe(3);
    expect(v.traceRows[0].count).toBe(1);
  });

  it('hidden commits retarget to their group trace row; x never changes', () => {
    const dead: Map<string, DeadKind> = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const a1 = v.data.commits.find(c => c.id === 'a1')!;
    const u1 = v.data.commits.find(c => c.id === 'u1')!;
    expect(a1.lane).toBe(2);
    expect(a1.y).toBe(2 * LANE_HEIGHT);
    expect(a1.x).toBe(150);
    expect(u1.lane).toBe(3);
    expect(u1.y).toBe(3 * LANE_HEIGHT);
    expect(v.hiddenIds.has('a1')).toBe(true);
    expect(v.hiddenIds.has('u1')).toBe(true);
    const m1 = v.data.commits.find(c => c.id === 'm1')!;
    expect(v.hiddenIds.has('m1')).toBe(false);
    expect(m1.y).toBe(0);
  });

  it('kept-lane commits get compacted y consistent with their lane row', () => {
    const dead: Map<string, DeadKind> = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const k1 = v.data.commits.find(c => c.id === 'k1')!;
    expect(k1.lane).toBe(1);
    expect(k1.y).toBe(1 * LANE_HEIGHT);
  });

  it('trace bars use PRE-collapse spans and lane colors', () => {
    const dead: Map<string, DeadKind> = new Map([['arch1', 'archived'], ['dorm1', 'dormant']]);
    const v = collapseLanes(mk(), dead);
    const arch = v.traceBars.find(b => b.laneIndex === 2)!;
    expect(arch.x1).toBe(150);
    expect(arch.x2).toBe(170);
    expect(arch.color).toBe('#aa0000');
    const dorm = v.traceBars.find(b => b.laneIndex === 3)!;
    expect(dorm.x1).toBe(180);
    expect(dorm.x2).toBe(180);
    expect(dorm.color).toBe('#00aa00');
  });

  it('a group with no collapsed lanes gets no trace row', () => {
    const dead: Map<string, DeadKind> = new Map([['arch1', 'archived']]); // nothing dormant
    const v = collapseLanes(mk(), dead);
    expect(v.traceRows.map(r => r.kind)).toEqual(['archived']);
    const u1 = v.data.commits.find(c => c.id === 'u1')!;
    expect(u1.lane).toBe(1); // dorm1 kept, compacted
    expect(v.hiddenIds.has('u1')).toBe(false);
  });
});
