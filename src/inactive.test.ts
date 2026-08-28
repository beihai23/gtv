import { describe, it, expect } from 'vitest';
import { computeInactive, LANE_HEIGHT } from './inactive';
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
    has_more: false,
  };
}

// --- tests ----------------------------------------------------------------

describe('computeInactive', () => {
  it('LANE_HEIGHT is a positive number', () => {
    expect(LANE_HEIGHT).toBeGreaterThan(0);
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
