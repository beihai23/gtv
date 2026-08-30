import type { BranchLane, CommitNode, SearchHit } from './types';

// ---------------------------------------------------------------------------
// Cmd+F locate: dual-source pipeline. matchLoaded runs instantly over the
// loaded window (branch/hash/message/author); the debounced backend search
// fills in full-history hits, which mergeLocate dedupes and orders.
// ---------------------------------------------------------------------------

// Remote-search hit cap: the backend stops its walk at this many hits, so the
// footer's "{n}+ matches" hint and the request limit must both read from here.
export const SEARCH_LIMIT = 50;

export type LocateResult =
  | { kind: 'branch'; name: string; color: string; commitId: string }
  | { kind: 'commit'; id: string; message: string; author: string; timestamp: number; in_view: boolean };

/** Lane-owner -> tip commit (the lane's commit with the highest x). The
 *  exact rule matchLoaded applies inline to resolve lane-name hits; exported
 *  so compare.ts resolves lane tips with identical semantics. matchLoaded
 *  keeps its own inline map -- refactoring its body to call this is off
 *  limits by design. */
export function laneTip(commits: CommitNode[]): Map<string, { id: string; x: number }> {
  const tips = new Map<string, { id: string; x: number }>();
  for (const c of commits) {
    const lt = tips.get(c.lane_owner);
    if (!lt || c.x > lt.x) tips.set(c.lane_owner, { id: c.id, x: c.x });
  }
  return tips;
}

/** Matches over the loaded view. Branch-name substring (any length, the
 *  long-standing behavior), hash prefix (>= 4 hex), and — new — subject or
 *  author substring (>= 2 chars, matching the backend's noise threshold).
 *  Commit hits are newest-first. hideRemotes (spec 4.3) skips is_remote refs
 *  when building the ref-name targets -- remote-only names stop matching,
 *  while same-named LOCAL lanes still hit through the untouched laneTip map. */
export function matchLoaded(
  commits: CommitNode[],
  branches: BranchLane[],
  query: string,
  hideRemotes = false,
): LocateResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const colorOf = new Map(branches.map(b => [b.name, b.color]));
  const refTarget = new Map<string, string>(); // ref name -> commit it points at
  const laneTip = new Map<string, { id: string; x: number }>();
  for (const c of commits) {
    for (const r of c.branch_refs) {
      if (hideRemotes && r.is_remote) continue;
      if (!r.is_tag && !refTarget.has(r.name)) refTarget.set(r.name, c.id);
    }
    const lt = laneTip.get(c.lane_owner);
    if (!lt || c.x > lt.x) laneTip.set(c.lane_owner, { id: c.id, x: c.x });
  }

  const out: LocateResult[] = [];
  const names = new Set([...refTarget.keys(), ...laneTip.keys()]);
  for (const name of names) {
    if (!name.toLowerCase().includes(q)) continue;
    const commitId = refTarget.get(name) ?? laneTip.get(name)!.id;
    out.push({ kind: 'branch', name, color: colorOf.get(name) ?? '#888', commitId });
  }
  out.sort((a, b) => (a.kind === 'branch' && b.kind === 'branch' ? a.name.localeCompare(b.name) : 0));

  const textOk = q.length >= 2;
  const isHex = /^[0-9a-f]{4,}$/.test(q);
  const commitHits: LocateResult[] = [];
  for (const c of commits) {
    const hashHit = isHex && c.id.startsWith(q);
    const textHit = textOk && (c.message.toLowerCase().includes(q) || c.author_name.toLowerCase().includes(q));
    if (!hashHit && !textHit) continue;
    commitHits.push({
      kind: 'commit', id: c.id, message: c.message.split('\n')[0],
      author: c.author_name, timestamp: c.timestamp, in_view: true,
    });
  }
  commitHits.sort((a, b) => (b.kind === 'commit' && a.kind === 'commit' ? b.timestamp - a.timestamp : 0));
  return [...out, ...commitHits];
}

/** Merges local (loaded-window) hits with backend full-history hits.
 *  Dedup is commit-kind only, local wins (local hits carry lane_owner
 *  context for dead-lane auto-expansion); branch and commit hits coexist
 *  (long-standing dropdown shape); commit hits newest-first; capped. */
export function mergeLocate(local: LocateResult[], remote: SearchHit[], cap = SEARCH_LIMIT): LocateResult[] {
  const branchHits = local.filter((r): r is Extract<LocateResult, { kind: 'branch' }> => r.kind === 'branch');
  const localCommits = local.filter(r => r.kind === 'commit');
  const seen = new Set(localCommits.map(r => (r.kind === 'commit' ? r.id : '')));
  const remoteOnly: LocateResult[] = remote
    .filter(h => !seen.has(h.id))
    .map(h => ({
      kind: 'commit' as const, id: h.id, message: h.message.split('\n')[0],
      author: h.author_name, timestamp: h.timestamp, in_view: h.in_view,
    }));
  const commitHits = [...localCommits, ...remoteOnly]
    .filter((r): r is Extract<LocateResult, { kind: 'commit' }> => r.kind === 'commit')
    .sort((a, b) => b.timestamp - a.timestamp);
  return [...branchHits, ...commitHits].slice(0, cap);
}
