import { describe, it, expect } from 'vitest';
import { matchLoaded, mergeLocate, SEARCH_LIMIT } from './locate';
import type { LocateResult } from './locate';
import type { BranchLane, CommitNode, SearchHit } from './types';

function commit(over: Partial<CommitNode>): CommitNode {
  return {
    id: 'aa00000000000000000000000000000000000000', short_id: 'aa00000',
    message: 'm', author_name: 'a', author_email: 'e', timestamp: 1000,
    parents: [], branch_refs: [], fork_branch_name: null, merge_branch_name: null,
    lane_owner: 'main', is_head: false, is_key: true, additions: 0, deletions: 0,
    x: 0, y: 0, lane: 0, ...over,
  };
}

function lane(name: string, over: Partial<BranchLane> = {}): BranchLane {
  return {
    name, lane_index: 0, color: '#00f', is_tag: false, fork_point: null,
    merged_into: null, is_active: true, ...over,
  };
}

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    id: 'bb00000000000000000000000000000000000000', message: 'm',
    author_name: 'a', timestamp: 1000, in_view: true, ...over,
  };
}

const commits = (): CommitNode[] => [
  commit({ id: 'a1c0f00000000000000000000000000000000000000', lane_owner: 'main', x: 10, message: 'Fix Login Bug', author_name: 'Alice', timestamp: 300 }),
  commit({ id: 'd4e5f6000000000000000000000000000000000', lane_owner: 'feat/x', x: 20, message: 'add settings', author_name: 'bob', timestamp: 200, branch_refs: [{ name: 'feat/x', is_remote: false, is_tag: false, color: '#0f0' }] }),
  commit({ id: '99990f0000000000000000000000000000000000', lane_owner: 'main', x: 30, message: 'old thing', author_name: 'Carol', timestamp: 100 }),
];

describe('matchLoaded', () => {
  it('matches branch names by substring (any length, case-insensitive)', () => {
    const out = matchLoaded(commits(), [lane('feat/x'), lane('main')], 'FEAT');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'branch', name: 'feat/x', commitId: 'd4e5f6000000000000000000000000000000000' });
  });

  it('matches subject and author when query >= 2 chars', () => {
    const out = matchLoaded(commits(), [lane('main')], 'login');
    expect(out.filter(r => r.kind === 'commit')).toHaveLength(1);
    const byAuthor = matchLoaded(commits(), [lane('main')], 'carol');
    expect(byAuthor.filter(r => r.kind === 'commit')).toHaveLength(1);
  });

  it('skips message/author matching for 1-char queries (noise control)', () => {
    expect(matchLoaded(commits(), [lane('main')], 'x').filter(r => r.kind === 'commit')).toHaveLength(0);
  });

  it('matches hash prefix >= 4 hex, newest first', () => {
    const out = matchLoaded(commits(), [lane('main')], 'a1c0');
    const cs = out.filter(r => r.kind === 'commit') as Array<{ id: string; in_view: boolean; author: string }>;
    expect(cs).toHaveLength(1);
    expect(cs[0].in_view).toBe(true);
    expect(cs[0].author).toBe('Alice');
  });

  it('empty query returns nothing', () => {
    expect(matchLoaded(commits(), [lane('main')], '')).toHaveLength(0);
    expect(matchLoaded(commits(), [lane('main')], '   ')).toHaveLength(0);
  });

  it('remote-only ref name matches by default, drops out with hideRemotes', () => {
    // 'origin/ghost' exists ONLY as an is_remote ref -- no lane of that name.
    const remoteOnly = () => [
      commit({
        id: 'c0ffee0000000000000000000000000000000000',
        lane_owner: 'main', x: 5,
        branch_refs: [{ name: 'origin/ghost', is_remote: true, is_tag: false, color: '#f00' }],
      }),
    ];
    const shown = matchLoaded(remoteOnly(), [lane('main')], 'ghost');
    const branchHits = shown.filter(r => r.kind === 'branch');
    expect(branchHits).toHaveLength(1);
    expect(branchHits[0]).toMatchObject({ kind: 'branch', name: 'origin/ghost' });

    const hidden = matchLoaded(remoteOnly(), [lane('main')], 'ghost', true);
    expect(hidden.filter(r => r.kind === 'branch')).toHaveLength(0);
  });

  it('same-named local lane still matches with hideRemotes (laneTip path untouched)', () => {
    // Lane 'ghost' carries only the remote ref 'origin/ghost': hiding remotes
    // must remove the ref hit but keep the lane-name hit.
    const data = () => [
      commit({
        id: 'abad1dea00000000000000000000000000000000',
        lane_owner: 'ghost', x: 5,
        branch_refs: [{ name: 'origin/ghost', is_remote: true, is_tag: false, color: '#f00' }],
      }),
    ];
    const shown = matchLoaded(data(), [lane('ghost')], 'ghost');
    expect(shown.filter(r => r.kind === 'branch').map(r => r.kind === 'branch' ? r.name : '')).toEqual(['ghost', 'origin/ghost']);

    const hidden = matchLoaded(data(), [lane('ghost')], 'ghost', true);
    const names = hidden.filter(r => r.kind === 'branch').map(r => r.kind === 'branch' ? r.name : '');
    expect(names).toEqual(['ghost']);
  });
});

describe('mergeLocate', () => {
  it('branch hits first, commit hits newest-first, deduped by id (local wins)', () => {
    const DUP_ID = 'a1c0f00000000000000000000000000000000000000'; // one oid, in local AND remote
    const local: LocateResult[] = [
      { kind: 'branch', name: 'feat/x', color: '#0f0', commitId: 'd4e5f6000000000000000000000000000000000' },
      { kind: 'commit', id: DUP_ID, message: 'Fix Login Bug', author: 'Alice', timestamp: 300, in_view: true },
    ];
    const remote: SearchHit[] = [
      hit({ id: DUP_ID, message: 'Fix Login Bug', timestamp: 300 }), // dup of local
      hit({ id: 'cc00000000000000000000000000000000000000', message: 'older login fix', timestamp: 50, in_view: false }),
    ];
    const out = mergeLocate(local, remote);
    expect(out[0].kind).toBe('branch'); // non-vacuous: a branch hit IS present
    const cs = out.filter(r => r.kind === 'commit') as Array<{ id: string; in_view: boolean }>;
    expect(cs.map(c => c.id)).toEqual([DUP_ID, 'cc00000000000000000000000000000000000000']);
    expect(cs[0].in_view).toBe(true);
    expect(cs[1].in_view).toBe(false);
  });

  it(`caps the merged list at SEARCH_LIMIT (${SEARCH_LIMIT}) and honors an explicit cap`, () => {
    const many = Array.from({ length: SEARCH_LIMIT + 30 }, (_, i) =>
      hit({ id: `f${i.toString().padStart(2, '0')}000000000000000000000000000000000000000`, timestamp: i }));
    expect(mergeLocate([], many).length).toBe(SEARCH_LIMIT);
    expect(mergeLocate([], many, 5).length).toBe(5);
  });

  it('empty inputs', () => {
    expect(mergeLocate([], [])).toEqual([]);
  });
});
