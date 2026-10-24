// Starred-view pipeline integration: modeHiddenLanes -> collapseLanes must
// reduce the canvas to exactly the starred lanes (+HEAD). Guards the
// "starred view still shows a pile of lanes" report.
import { describe, it, expect } from 'vitest';
import { modeHiddenLanes } from './laneview';
import { collapseLanes } from './inactive';
import type { BranchLane, CommitNode, GitData } from './types';

const lane = (name: string, lane_index: number): BranchLane => ({
  name, lane_index, color: '#888888', is_tag: false,
  fork_point: null, merged_into: null, is_active: true, is_remote: false,
});
const commit = (id: string, lane: number, owner: string, x: number, ts: number): CommitNode => ({
  id, short_id: id.slice(0, 7), message: 'm', author_name: 'a', author_email: 'e',
  timestamp: ts, parents: [], branch_refs: [], fork_branch_name: null,
  merge_branch_name: null, lane_owner: owner, is_head: false, is_key: true,
  additions: 0, deletions: 0, x, y: lane * 80, lane,
});
const data: GitData = {
  commits: [], edges: [], branches: [], main_branch: 'main',
  time_gaps: [], has_more: false, head_branch: 'main', head_commit_count: null,
};

const LANES = [lane('main', 0), ...Array.from({ length: 39 }, (_, i) => lane(`br/${i}`, i + 1))];
const COMMITS = LANES.map((l, i) => commit(`c${i}`, i, l.name, i * 40, 1_000_000 + i));
const REPO: GitData = { ...data, commits: COMMITS, branches: LANES };
const STARS = new Set(['br/1', 'br/4', 'br/7', 'br/11', 'br/16', 'br/22', 'br/28', 'br/33', 'br/38']);

describe('starred view excludes everything but the stars (+HEAD)', () => {
  it('view.branches reduces to stars + HEAD lane', () => {
    const hidden = modeHiddenLanes(
      'starred', LANES, STARS, 'main',
      name => parseInt(name.slice(4), 10), new Set(),
    );
    expect(hidden.size).toBe(40 - STARS.size - 1); // everything but stars + HEAD
    const view = collapseLanes(REPO, new Map([...hidden].map(n => [n, 'excluded' as const])));
    const names = view.data.branches.map(b => b.name).sort();
    expect(names).toEqual(['br/1', 'br/11', 'br/16', 'br/22', 'br/28', 'br/33', 'br/38', 'br/4', 'br/7', 'main']);
    // Commits of excluded lanes are gone from the display data.
    expect(view.data.commits.some(c => c.id === 'c3')).toBe(false); // c3 -> br/2, excluded
    expect(view.data.commits.some(c => c.id === 'c2')).toBe(true); // c2 -> br/1, starred
  });

  it('the no-blank guard cannot silently keep every lane when stars exist', () => {
    // Regression shape: even with a large keep set the guard only fires when
    // NOTHING would remain — 9 stars out of 40 must still exclude 31.
    const hidden = modeHiddenLanes('starred', LANES, STARS, null, () => 0, new Set());
    expect(hidden.size).toBe(31);
  });
});
