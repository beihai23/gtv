// Synthetic bench fixture: a 100-lane / ~5k-commit repository dump in the
// GitData shape public/mock-data.json carries. Shapes the exact scenario of
// the "100 lanes, 5k commits, slow starred/all switch after a fetch" report:
// one trunk lane, 99 side lanes (most dormant past the 90-day freshness
// cutoff), remote-tracking counterpart refs on most tips (the post-fetch
// state), a handful of tags. Usage:
//   node docs/tools/gen_bench_mockdata.mjs > public/mock-data.json
// public/mock-data.json is committed — restore it with
//   git checkout -- public/mock-data.json

const LANES = 99;           // side lanes besides main
const MAIN_COMMITS = 2450;  // trunk commits
const BRANCH_MIN = 15, BRANCH_MAX = 30;
const MERGE_RATIO = 0.55;   // branches that fold back into main
const REMOTE_RATIO = 0.6;   // tips carrying an origin/ counterpart (post-fetch)
const X_SPACING = 14;
const NOW = Math.floor(Date.now() / 1000);
const SPAN_DAYS = 730;

let seed = 0x2f6e2b1;
const rand = () => {
  // xorshift32, deterministic output
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0xffffffff;
};
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const commits = [];
const edges = [];
const branches = [];
const laneColor = (i) => {
  const hue = (i * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 62%, ${i === 0 ? 62 : 55}%)`;
};

branches.push({
  name: 'main', lane_index: 0, color: laneColor(0), is_tag: false,
  fork_point: null, merged_into: null, is_active: true, is_remote: false,
});

const t0 = NOW - SPAN_DAYS * 86400;
// Trunk commits, oldest -> newest, spread over the whole span.
const mainIds = [];
for (let i = 0; i < MAIN_COMMITS; i++) {
  const ts = Math.floor(t0 + (SPAN_DAYS * 86400 * i) / MAIN_COMMITS);
  const id = `m${i.toString(36).padStart(4, '0')}${randInt(0, 0xffff).toString(16).padStart(4, '0')}`;
  mainIds.push(id);
  commits.push({
    id, short_id: id.slice(0, 7), message: `trunk commit ${i}`,
    author_name: 'bench', author_email: 'bench@example.com',
    timestamp: ts, parents: i > 0 ? [mainIds[i - 1]] : [],
    branch_refs: [], fork_branch_name: null, merge_branch_name: null,
    lane_owner: 'main', is_head: false, is_key: false,
    additions: 0, deletions: 0, x: 0, y: 0, lane: 0,
  });
}

// Side lanes: fork out of a trunk commit, burst of own commits, maybe merge
// back. Older forks (most of them) end up dormant past the 90-day cutoff.
let laneSeq = 0;
for (let b = 0; b < LANES; b++) {
  const lane = b + 1;
  const forkAt = randInt(30, MAIN_COMMITS - 60); // trunk index of the fork point
  const forkId = mainIds[forkAt];
  const forkTs = commits[forkAt].timestamp;
  const name = `feature/lane-${b.toString().padStart(2, '0')}`;
  branches.push({
    name, lane_index: lane, color: laneColor(lane), is_tag: false,
    fork_point: forkId, merged_into: null, is_active: true, is_remote: false,
  });
  const n = randInt(BRANCH_MIN, BRANCH_MAX);
  const ids = [];
  // The branch's burst ENDS inside the freshness window (all tips < 90 days
  // old) so the 100 lanes all stay alive on canvas — the worst case the
  // report describes.
  const lastTs = NOW - randInt(1, 60) * 86400;
  for (let i = 0; i < n; i++) {
    const ts = forkTs + ((lastTs - forkTs) * i) / (n - 1 || 1);
    const id = `b${b.toString(36).padStart(3, '0')}i${i.toString(36).padStart(3, '0')}${randInt(0, 0xfff).toString(16).padStart(3, '0')}`;
    ids.push(id);
    commits.push({
      id, short_id: id.slice(0, 7), message: `${name} step ${i}`,
      author_name: 'bench', author_email: 'bench@example.com',
      timestamp: Math.min(Math.floor(ts), NOW - 86400), parents: i > 0 ? [ids[i - 1]] : [forkId],
      branch_refs: [], fork_branch_name: null, merge_branch_name: null,
      lane_owner: name, is_head: false, is_key: false,
      additions: 0, deletions: 0, x: 0, y: 0, lane,
    });
  }
  commits.push({
    id: `fk${b.toString(36).padStart(3, '0')}${randInt(0, 0xfff).toString(16).padStart(3, '0')}`,
    short_id: 'f000000', message: 'placeholder', author_name: 'bench',
    author_email: 'bench@example.com', timestamp: 0, parents: [],
    branch_refs: [], fork_branch_name: null, merge_branch_name: null,
    lane_owner: '', is_head: false, is_key: false,
    additions: 0, deletions: 0, x: 0, y: 0, lane: 0,
  });
  commits.pop(); // (kept no placeholder — fork evidence lands below)
  // Fork evidence on the trunk commit + Branch edge into the lane's first commit.
  const laneColorName = name;
  const forkCommit = commits[forkAt];
  forkCommit.fork_branch_name = forkCommit.fork_branch_name
    ? `${forkCommit.fork_branch_name}, ${laneColorName}` : laneColorName;
  forkCommit.is_key = true;
  edges.push({ from: ids[0], to: forkId, edge_type: 'Branch' });

  const merges = rand() < MERGE_RATIO;
  if (merges) {
    // Merge commit on main, shortly after the branch tip.
    const tipId = ids[ids.length - 1];
    const tipTs = commits.find(c => c.id === tipId).timestamp;
    const mId = `g${b.toString(36).padStart(3, '0')}${randInt(0, 0xfff).toString(16).padStart(3, '0')}`;
    commits.push({
      id: mId, short_id: mId.slice(0, 7), message: `Merge branch '${name}' into main`,
      author_name: 'bench', author_email: 'bench@example.com',
      timestamp: Math.min(tipTs + randInt(1, 20) * 3600, NOW - 3600),
      parents: [], branch_refs: [], fork_branch_name: null,
      merge_branch_name: name, lane_owner: 'main', is_head: false,
      is_key: true, additions: 0, deletions: 0, x: 0, y: 0, lane: 0,
    });
    const mergedInto = `feature/lane-${b.toString().padStart(2, '0')}`;
    branches[lane].merged_into = mergedInto;
    edges.push({ from: tipId, to: mId, edge_type: 'Merge' });
  } else {
    // Live tip: local ref, plus the remote counterpart on REMOTE_RATIO of them
    // (the post-fetch state the report describes).
    const tip = commits.find(c => c.id === ids[ids.length - 1]);
    tip.is_key = true;
    tip.branch_refs.push({ name, is_remote: false, is_tag: false, color: '' });
    if (rand() < REMOTE_RATIO) {
      tip.branch_refs.push({ name: `origin/${name}`, is_remote: true, is_tag: false, color: '' });
    }
  }
}

// Trunk chain edges (child -> parent) + refs/HEAD.
for (let i = 0; i < MAIN_COMMITS - 1; i++) {
  edges.push({ from: mainIds[i + 1], to: mainIds[i], edge_type: 'Direct' });
}
for (const m of commits) {
  if (m.lane_owner === 'main' && m.parents.length === 0 && m.merge_branch_name === null) {
    // merge commits get their first-parent edge below
  }
}
// Merge commits: first parent = previous trunk commit, edge from it.
const byTime = [...commits].sort((a, b) => a.timestamp - b.timestamp);
let prevTrunk = null;
for (const c of byTime) {
  if (c.lane_owner !== 'main') continue;
  if (c.merge_branch_name) {
    // first parent: the trunk commit merged on top of — approximate with the
    // latest earlier trunk commit by timestamp.
    c.parents = [prevTrunk ?? ''];
    if (prevTrunk) edges.push({ from: c.id, to: prevTrunk, edge_type: 'Direct' });
  } else {
    prevTrunk = c.id;
  }
}
const mainTip = byTime.filter(c => c.lane_owner === 'main').pop();
mainTip.is_head = true;
mainTip.is_key = true;
mainTip.branch_refs.push({ name: 'main', is_remote: false, is_tag: false, color: '' });
mainTip.branch_refs.push({ name: 'origin/main', is_remote: true, is_tag: false, color: '' });

// A few tags on random trunk commits.
for (let tg = 0; tg < 5; tg++) {
  const c = commits[randInt(0, MAIN_COMMITS - 1)];
  c.is_key = true;
  c.branch_refs.push({ name: `v1.${tg}.0`, is_remote: false, is_tag: true, color: '' });
  branches.push({
    name: `v1.${tg}.0`, lane_index: 0, color: '#9C27B0', is_tag: true,
    fork_point: null, merged_into: null, is_active: true, is_remote: false,
  });
}

// Global chronological x cascade, y = lane row.
byTime.forEach((c, i) => { c.x = i * X_SPACING; });
for (const c of commits) {
  const b = branches.find(br => br.name === c.lane_owner);
  c.lane = b ? b.lane_index : 0;
  c.y = c.lane * 80;
}

const dump = {
  commits, edges, branches, main_branch: 'main', time_gaps: [],
  has_more: false, head_branch: 'main', head_commit_count: commits.length,
};
process.stdout.write(JSON.stringify(dump));
