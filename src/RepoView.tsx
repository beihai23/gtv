import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction, CSSProperties } from 'react';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { CompareDetails } from './components/CompareDetails';
import { IssueReportDialog } from './components/IssueReportDialog';
import { CheckoutDialog } from './components/CheckoutDialog';
import TerminalPanel from './components/TerminalPanel';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from './settings';
import { getCommitDetail, getBranchList, filterByBranches, setIncludeStale, refreshRepository, fetchRepository, switchBranch, getPatchLinks, getCommitStats, loadOlderCommits, searchCommits, jumpToCommit, getWorktreeStatus, checkoutBranch, openHostTerminal } from './api';
import { recordFrontendError } from './issueContext';
import { computeInactive, collapseLanes, DEAD_KINDS } from './inactive';
import type { DeadKind, SedimentKind } from './inactive';
import { modeHiddenLanes, ACTIVE_MODE_SIZE } from './laneview';
import type { LaneViewMode } from './laneview';
import { applyDateRange, emptyLaneDead, outOfRangeIds } from './daterange';
import type { DateRange } from './daterange';
import { savePinned, loadPinned } from './persist';
import { saveDateRange, loadDateRange } from './viewpersist';
import { clampDetailsWidth, loadDetailsWidth, saveDetailsWidth } from './detailSize';
import { pruneRemoteLanes } from './refs';
import { relatedLanes } from './related';
import { matchLoaded, mergeLocate, SEARCH_LIMIT } from './locate';
import type { LocateResult } from './locate';
import { nextPair } from './compare';
import type { ComparePair } from './compare';
import type { GitData, CommitDetail, BranchLane, PatchLink, RepoChanged, WorktreeStatus, WorktreeMember } from './types';
import type { SearchHit } from './types';

// Per-repo view body (multi-repo-tabs Tasks 4+5): everything that depends
// on ONE opened repository -- data state, display-pipeline memos,
// handlers, header/toolbar, panels, terminal. App.tsx owns the tab shell:
// it opens repos (single openTab entry, backend-deduped), restores them,
// and mounts one RepoView per tab (kept alive via display:none; `active`
// gates the keyboard handlers and the issue-dialog render). The view data
// arrives as initialData from the tab's open; repo-changed events are
// filtered on repo_id. Moved code keeps its original declaration order
// (TDZ rule, the M1.3 lesson).
interface RepoViewProps {
  // Registry identity + open-time data: App ran the open and owns the
  // tab; RepoView never opens anything itself (the picker moved to App
  // with the rest of the open flow).
  repoId: number;
  path: string;
  initialData: GitData;
  // The tab's worktree family (App's snapshot): drives the member
  // selector when more than one member exists.
  family: WorktreeMember[];
  /** Member switch (worktree selector): re-opens `path` through App's
   *  openTab, which re-points this family's tab at that member. */
  onSwitchMember: (path: string) => void;
  /** Family re-enumeration (App's refreshFamily): the member menu calls
   *  it on every open -- members other than the watched one can be
   *  added or removed externally, and the moment the list is looked at
   *  is the moment freshness matters. */
  onRefreshFamily: (repoId: number) => void;
  // True while this tab is the active one. Keyboard handlers bail when
  // inactive (N kept-alive tabs must not double-fire shortcuts) and the
  // issue-report dialog renders only here (exactly one z-80 dialog, the
  // active tab's -- T4 review Low-3). Activation itself re-runs Timeline's
  // draw (`active` is in its deps) so D3 re-measures after display:none;
  // the camera is deliberately NOT touched on activation -- a remembered
  // zoom/pan must survive tab switches.
  active: boolean;
  // Global display preferences (App-owned so every tab shares them).
  showTags: boolean;
  toggleShowTags: () => void;
  compressed: boolean;
  setCompressed: Dispatch<SetStateAction<boolean>>;
  showMergeLinks: boolean;
  setShowMergeLinks: Dispatch<SetStateAction<boolean>>;
  showRefLabels: boolean;
  setShowRefLabels: Dispatch<SetStateAction<boolean>>;
  showAnnotations: boolean;
  setShowAnnotations: Dispatch<SetStateAction<boolean>>;
  // Global dialog VISIBILITY lives in App while the per-repo context
  // (error, repo path, commit count) lives here: the issue dialog renders
  // inside RepoView and takes the path as a prop.
  showIssueReport: boolean;
  setShowIssueReport: (v: boolean) => void;
}

// Stable empty-set fallback so the Timeline props keep one identity when no
// view is computed (avoids per-render Set churn re-triggering its effects).
const NO_IDS: Set<string> = new Set();

// Same stable-identity trick for the patchLinks "off" branch: a fresh []
// per render would land in Timeline's draw-effect deps and force a full d3
// scene redraw on every App render (NO_IDS precedent).
const NO_LINKS: PatchLink[] = [];

// Branch/tag chip labels: show the full name up to this many chars; longer
// names keep head and tail with an ellipsis in the middle (CSS can only
// truncate at the end, which hides the distinguishing tail of long names).
const CHIP_LABEL_MAX = 32;

function truncateMiddle(name: string, max: number = CHIP_LABEL_MAX): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

// Caught values are `unknown`; the issue-report ring buffer wants the message.
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function RepoView({
  repoId,
  path,
  initialData,
  family,
  onSwitchMember,
  onRefreshFamily,
  active,
  showTags,
  toggleShowTags,
  compressed,
  setCompressed,
  showMergeLinks,
  setShowMergeLinks,
  showRefLabels,
  setShowRefLabels,
  showAnnotations,
  setShowAnnotations,
  showIssueReport,
  setShowIssueReport,
}: RepoViewProps) {
  const { t, showStaleBranches, inactiveDays, hideRemotes, setHideRemotes } = useSettings();
  // Seeded from the tab's open (App): the view exists the moment this
  // component mounts; the null branch below stays only as a defensive
  // loading/error shape.
  const [gitData, setGitData] = useState<GitData | null>(initialData);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchList, setBranchList] = useState<BranchLane[]>([]);
  // Names of remote-only lanes (no local counterpart). The remotes toggle
  // prunes these from every selection that goes to filterByBranches — their
  // lanes vanish while the backend closure keeps fork-parent context.
  const remoteLaneNames = useMemo(
    () => new Set(branchList.filter(b => b.is_remote).map(b => b.name)),
    [branchList],
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  // Starred branches: the durable "branches I care about" marks behind the
  // ★ view mode. Deliberately SEPARATE from selectedBranches -- the
  // selection is the current answer, stars are the user's intent, so no
  // selection edit (panel row, chip click) can clobber them. Persisted per
  // repo (gtv_branch_pins) and lazy-initialized from storage: the save
  // effect below fires on mount with whatever the state holds, so an
  // empty-init + async load would WIPE the stored stars before the load
  // landed (they vanished on every reopen -- the persistence report).
  const [pinnedBranches, setPinnedBranches] = useState<string[]>(() => loadPinned(path) ?? []);
  const [showAllTags, setShowAllTags] = useState(false);
  // Combobox keyboard highlight: index into the panel's listed rows while
  // the toolbar filter field drives navigation (↑/↓ move, Enter toggles).
  const [rowHighlight, setRowHighlight] = useState(0);
  // Transient copy feedback (bottom-center toast): { name, ok } | null.
  const [copyToast, setCopyToast] = useState<{ name: string; ok: boolean } | null>(null);
  // Fetch button: in-flight flag + transient result toast (failure summary
  // or the quiet "up to date" confirmation).
  const [fetching, setFetching] = useState(false);
  const [fetchToast, setFetchToast] = useState<{ ok: boolean; text: string } | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  // One exit path for the ref panel: closing always drops the query and
  // the keyboard highlight with it -- the query lives only as long as the
  // panel does, so no closed panel leaves a zombie filter behind (the
  // leak-bug lesson, applied to the new toolbar field).
  const closePanel = useCallback(() => {
    setShowAllTags(false);
    setSearchQuery('');
    setRowHighlight(0);
  }, []);
  // View-options popover (low-frequency global presentation toggles live
  // collapsed behind one trigger instead of a six-button wall).
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // Worktree-member popover (same low-frequency-popover idiom): the
  // family selector that replaced second-level member tabs. A member is
  // an anchor parameter of THIS view, not another view.
  const [memberMenuOpen, setMemberMenuOpen] = useState(false);
  // M3.1 checkout: pending dirty-worktree confirm (null until the preflight
  // reports a dirty worktree) and the branch of the last successful switch
  // (drives the transient success banner; null = no banner).
  const [checkoutDialog, setCheckoutDialog] = useState<{ branch: string; status: WorktreeStatus } | null>(null);
  const [switchedBranch, setSwitchedBranch] = useState<string | null>(null);
  // M3.2 compare pairing (spec 4.4): null = idle; target '' = half-pair
  // (base picked, the canvas rings it via compareBaseId); target set =
  // complete pair and the CompareDetails panel takes over the
  // CommitDetails slot.
  const [comparePair, setComparePair] = useState<ComparePair | null>(null);
  // Details/compare wide split view (DiffSplitView): the toggle lives in
  // the panel components, but the timeline must hide behind it -- the
  // panels report through onWideChange. Only honored while a panel is
  // actually open (splitOpen below).
  const [detailsWide, setDetailsWide] = useState(false);
  // Narrow panel width (the same slot serves CommitDetails and
  // CompareDetails): drag the divider at its left edge, clamp, persist on
  // release (gtv_details_width -- the terminal panel's idiom mirrored).
  // The value reaches the panel's CSS as a custom property; .wide ignores
  // it (width:auto wins).
  const [detailsWidth, setDetailsWidth] = useState(() => loadDetailsWidth(window.innerWidth));
  const detailsDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // preventDefault keeps the drag from starting a text selection.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    detailsDragRef.current = { startX: e.clientX, startWidth: detailsWidth };
  };
  const onResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!detailsDragRef.current) return;
    setDetailsWidth(clampDetailsWidth(
      detailsDragRef.current.startWidth - (e.clientX - detailsDragRef.current.startX),
      window.innerWidth,
    ));
  };
  const onResizerPointerUp = () => {
    if (!detailsDragRef.current) return;
    detailsDragRef.current = null;
    saveDetailsWidth(detailsWidth);
  };
  // Integrated terminal (bottom panel). `termOpen` is deliberately not
  // persisted: auto-restoring it would silently spawn a login shell on
  // every launch — a terminal should be an explicit user action.
  const [termOpen, setTermOpen] = useState(false);
  const [termAvailable, setTermAvailable] = useState(true);
  // Worktree cleanliness marker in the identity card. Refreshed on mount /
  // member switch (repoId change), after each view rebuild, and after a
  // checkout; the watcher deliberately ignores worktree-only churn
  // (change_fingerprint), so this is an on-refresh indicator, not a live
  // monitor.
  const [wtStatus, setWtStatus] = useState<WorktreeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    getWorktreeStatus(repoId)
      .then(s => { if (!cancelled) setWtStatus(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [repoId]);
  // VS Code host (flag set by media/bridge.js): no webview PTY — the
  // terminal button opens VS Code's own integrated terminal instead.
  const isVsCodeHost = typeof window !== 'undefined'
    && (window as unknown as { __GTV_HOST__?: string }).__GTV_HOST__ === 'vscode';
  // Stable identity so TerminalPanel's ensureSession memoization holds
  // (final-review F1): an inline arrow here changed on every render, which
  // un-memoed ensureSession and re-ran the panel's visibility effect on
  // every host render -- one redundant terminal_spawn per keystroke in the
  // locate box, and its term.focus() call stole focus from whatever the
  // user was typing into.
  const handleTermUnavailable = useCallback(() => setTermAvailable(false), []);

  // Fit signal is internal to the tab (Task 5): the Fit button bumps it.
  // (Activation deliberately does NOT: the draw re-run via the `active` dep
  // re-measures the canvas, and fitting would throw the user's remembered
  // zoom/pan away on every tab switch.)
  const [fitSignal, setFitSignal] = useState(0);
  // "Go home" (Age-of-Empires camera snap to HEAD): the header button and
  // the H key both bump this; Timeline owns the camera work.
  const [headSignal, setHeadSignal] = useState(0);

  // A popover left open in this tab while the user switched away would sit
  // stale on a keep-alive tab -- close it on deactivate (and its backdrop
  // with it, which would otherwise swallow clicks on the visible tab).
  useEffect(() => {
    if (!active) {
      setViewMenuOpen(false);
      setMemberMenuOpen(false);
      closePanel();
    }
  }, [active, closePanel]);

  // The member menu re-enumerates the family on every OPEN: only the
  // current member has a watcher, so members added or removed externally
  // (git worktree add/remove elsewhere) are invisible until the list is
  // looked at -- and the dropdown opening is exactly that moment. A
  // removed member drops out here (the backend skips paths that are
  // gone) instead of sitting in the list erroring on click.
  useEffect(() => {
    if (memberMenuOpen) onRefreshFamily(repoId);
  }, [memberMenuOpen, repoId, onRefreshFamily]);

  // Ctrl+` toggles the bottom terminal — works with focus anywhere,
  // including inside the xterm textarea (whose keydown we do NOT bail on
  // like the arrow-keys handler below; xterm's custom handler steps aside
  // for this combo and the event still bubbles here). Ctrl only: Cmd+` is
  // the macOS cycle-windows shortcut and must stay free. Active tab only:
  // kept-alive siblings register the same listener and must stay silent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && gitData && active) {
        e.preventDefault();
        setTermOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gitData, active]);
  const [viewResetKey, setViewResetKey] = useState(0);
  // Header search: jump to a commit by hash prefix or branch name.
  const [locateQuery, setLocateQuery] = useState('');
  const [locateOpen, setLocateOpen] = useState(false);
  const [locateIndex, setLocateIndex] = useState(0);
  const [focusTarget, setFocusTarget] = useState<{ id: string; seq: number } | null>(null);
  const focusSeqRef = useRef(0);
  // Debounced full-history search results merged into the dropdown.
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  const [remotePending, setRemotePending] = useState(false);
  // Date-range window (M2.2): pure display state, session-only -- never
  // persisted, and the stale-toggle rebuild resets it to 'all' (the old
  // re-open did the same; per-repo state starts clean on mount anyway).
  // The Custom inputs keep their own 'YYYY-MM-DD' strings so switching
  // presets and back never loses what the user typed.
  const [dateRange, setDateRange] = useState<DateRange>({ kind: 'all' });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Cherry-pick / rebase copy detection (expensive: one diff per commit),
  // computed on demand when the toggle is switched on.
  const [showPatchLinks, setShowPatchLinks] = useState(false);
  const [patchLinks, setPatchLinks] = useState<PatchLink[]>([]);
  const [patchLinksLoading, setPatchLinksLoading] = useState(false);
  // Branch name while the header position pill is hovered; Timeline turns
  // it into a transient focus of the "you are here" lane.
  const [headLaneHover, setHeadLaneHover] = useState<string | null>(null);

  // Inactive-lane collapse: which dead lanes the user has restored.
  const [expandedDead, setExpandedDead] = useState<Set<string>>(new Set());
  // Map-model narrowing, both DISPLAY-level (instant, no backend trip):
  // userCollapsed = lanes folded from the canvas (chip × / lane menu),
  // deliberately session-only -- reopening the app must never start with
  // lanes missing. viewMode = the header trio (all / ★ starred / active N),
  // a COMPUTED fold set that re-derives from current activity on every
  // refresh, so the lit pill never lies (the old lens presets did).
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<LaneViewMode>('all');
  // The restore set the whole fold pipeline respects: the eye toggles, plus
  // -- in the starred mode -- the stars themselves. A star means "at hand":
  // a starred dormant lane must surface in the starred view, not stay
  // buried under the freshness rule.
  const restoredSet = useMemo(
    () => (viewMode === 'starred' ? new Set([...expandedDead, ...pinnedBranches]) : expandedDead),
    [viewMode, expandedDead, pinnedBranches],
  );

  // Display pipeline (M2.2 order iron rule): gitData -> applyDateRange ->
  // computeInactive(filtered) -> dead union -> collapseLanes. collapseLanes
  // MUST receive the applyDateRange output: it rewrites lane/y coordinates,
  // so mixing views from different snapshots would misplace rows. `view` is
  // the display copy handed to Timeline; `inactive.groups` still lists
  // user-expanded lanes (checked state) even though they left `dead`.
  // Declared above the handlers because expandTraceGroup (via mergedGroups)
  // and handleLocate close over `inactive`.
  const rangedData = useMemo(
    () => (gitData ? applyDateRange(gitData, dateRange) : null),
    [gitData, dateRange],
  );
  // Non-tag lanes the window emptied out, in computeInactive's InactiveInfo
  // shape so the panel groups can mirror them (dead for the canvas union,
  // groups for the panel chips). Computed only while a window is ACTIVE:
  // under 'all' it must never run -- real repos carry non-tag lanes with no
  // own loaded commits (release/v1.x-style ref-only lanes, stale lanes whose
  // whole history sits outside the load window), and sinking those would
  // make them unrecoverable and diverge the default view from its pre-arc
  // behavior (arc invariant 2: 'all' is byte-identical to before).
  // Unioned ON TOP of the freshness rule below: range-empty wins -- a lane
  // active by wall-clock but empty inside the window is still noise in this
  // view.
  const rangeEmpty = useMemo(
    () => (dateRange.kind !== 'all' && rangedData ? emptyLaneDead(rangedData, restoredSet) : null),
    [dateRange.kind, rangedData, restoredSet],
  );
  const inactive = useMemo(
    () => (rangedData ? computeInactive(rangedData, inactiveDays, restoredSet) : null),
    [rangedData, inactiveDays, restoredSet],
  );
  // Latest activity time per ref (branch lane or tag), derived from the
  // loaded commits; feeds the branch-chip ordering AND the `active` view
  // mode's top-N (declared here because the mode fold set reads it).
  const refActivity = useMemo(() => {
    const map = new Map<string, number>();
    if (gitData) {
      for (const c of gitData.commits) {
        const prev = map.get(c.lane_owner);
        if (prev === undefined || c.timestamp > prev) map.set(c.lane_owner, c.timestamp);
        for (const r of c.branch_refs) {
          const p = map.get(r.name);
          if (p === undefined || c.timestamp > p) map.set(r.name, c.timestamp);
        }
      }
    }
    return map;
  }, [gitData]);
  // Names the freshness rule / date window already fold (BEFORE any display
  // narrowing): the view modes compute over what is still alive.
  const baseDeadNames = useMemo(() => {
    const s = new Set<string>();
    for (const name of inactive?.dead.keys() ?? []) s.add(name);
    for (const name of rangeEmpty?.dead.keys() ?? []) s.add(name);
    return s;
  }, [inactive, rangeEmpty]);
  // Display-level fold map (map model). 'all' keeps today's semantics:
  // manual canvas folds become 'hidden' sediment rows on top of the
  // freshness/date-window rules. Narrowed modes (★ starred / active) go
  // further — every lane outside the keep set is 'excluded' and VANISHES
  // from the canvas outright (no sediment row, no bars; the mode means
  // "show exactly these"), with the freshness classification skipped
  // entirely. Manual folds still win over the mode (a folded starred lane
  // stays folded), and restoredSet -- the eye toggles, plus the stars
  // themselves in the starred mode ("at hand") -- always survives.
  const modeDead = useMemo(() => {
    const hidden = new Map<string, DeadKind>();
    if (!rangedData || !gitData) return hidden;
    if (viewMode === 'all') {
      for (const name of userCollapsed) {
        if (!baseDeadNames.has(name) && !restoredSet.has(name)) hidden.set(name, 'hidden');
      }
      return hidden;
    }
    const names = modeHiddenLanes(
      viewMode,
      rangedData.branches.filter(b => !b.is_tag),
      new Set(pinnedBranches),
      gitData.head_branch,
      name => refActivity.get(name) ?? 0,
      restoredSet,
    );
    for (const name of names) hidden.set(name, 'excluded');
    for (const name of userCollapsed) {
      if (!restoredSet.has(name)) hidden.set(name, 'hidden');
    }
    return hidden;
  }, [rangedData, gitData, viewMode, pinnedBranches, refActivity, restoredSet, userCollapsed]);
  const dead = useMemo(() => {
    const m = new Map(modeDead);
    // Narrowed modes carry their own universe (kept lanes + excluded
    // everything else) — layering the freshness/date-window rules on top
    // would reclassify vanishing lanes as sediment rows behind the mode's
    // back.
    if (viewMode === 'all') {
      for (const [k, v] of inactive?.dead ?? []) m.set(k, v);
      for (const [k, v] of rangeEmpty?.dead ?? []) m.set(k, v);
    }
    return m;
  }, [modeDead, inactive, rangeEmpty, viewMode]);
  // Runtime diagnostic for view-narrowing reports (readable in the webview
  // console: Help > Toggle Developer Tools): one line per mode/star/branch
  // change. The state combination is exactly what the "starred view still
  // shows everything" class of reports needs to be actionable.
  const excludedCount = useMemo(() => {
    let n = 0;
    for (const kind of modeDead.values()) if (kind === 'excluded') n++;
    return n;
  }, [modeDead]);
  useEffect(() => {
    let excluded = 0;
    for (const kind of modeDead.values()) if (kind === 'excluded') excluded++;
    console.debug(
      '[gtv] view', viewMode,
      `stars=${pinnedBranches.length}`,
      `lanes=${branchList.length}`,
      `excluded=${excluded}`,
      `stars=[${pinnedBranches.join(',')}]`,
    );
  }, [viewMode, modeDead, pinnedBranches, branchList]);
  // Sibling members' checkouts (branch -> member name), current member
  // excluded: Timeline badges those lanes with a house marker. Memoized
  // for identity -- it sits in Timeline's draw-effect deps.
  const memberLanes = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of family) {
      if (mem.path === path || !mem.head_branch) continue;
      m.set(mem.head_branch, mem.name);
    }
    return m;
  }, [family, path]);
  const view = useMemo(
    () => (rangedData ? collapseLanes(rangedData, dead) : null),
    [rangedData, dead],
  );
  // Ids the window dropped, from the ORIGINAL unfiltered data: arrow-key
  // stepping skips them (focusing one would focus empty canvas) and locate
  // demotes out-of-window remote hits onto the jump path.
  const outOfRange = useMemo(
    () => (gitData ? outOfRangeIds(gitData, dateRange) : NO_IDS),
    [gitData, dateRange],
  );
  const hiddenIds = view?.hiddenIds ?? NO_IDS;

  // Dropdown plumbing: the <select>'s value (presets map to their day
  // count, 'all'/'custom' to their own option) and the Custom window
  // builder. Empty inputs fall back (from: 0 = the beginning, to: newest
  // loaded ts, i.e. the preset anchor) so a half-filled range never feeds
  // NaN seconds into the pipeline.
  const dateRangeValue =
    dateRange.kind === 'preset' ? String(dateRange.days) : dateRange.kind;
  const maxLoadedTs = useMemo(() => {
    let max = 0;
    if (gitData) for (const c of gitData.commits) if (c.timestamp > max) max = c.timestamp;
    return max;
  }, [gitData]);
  const customRange = (from: string, to: string): DateRange => ({
    kind: 'custom',
    start: from ? Math.floor(new Date(from).getTime() / 1000) : 0,
    // Whole chosen day: without +86399 the "To" day's own mid-day commits drop out, contradicting presets (anchored at the newest mid-day ts, which keeps that day).
    end: to ? Math.floor(new Date(to).getTime() / 1000) + 86399 : maxLoadedTs,
  });
  // Merged dead groups: freshness rule + range-empty lanes, name-deduped.
  // Same lane can sit in both maps (own commits all outside the window AND
  // stale by wall clock) -- classification is identical (merged_into ?
  // archived : dormant), so first occurrence wins.
  const mergedGroups = useMemo((): Record<SedimentKind, BranchLane[]> => {
    const merge = (kind: 'archived' | 'dormant'): BranchLane[] => {
      const seen = new Set<string>();
      const out: BranchLane[] = [];
      for (const l of [...(inactive?.groups[kind] ?? []), ...(rangeEmpty?.groups[kind] ?? [])]) {
        if (seen.has(l.name)) continue;
        seen.add(l.name); out.push(l);
      }
      return out;
    };
    // Folded lanes (user × / view mode), resolved to their BranchLane for
    // the panel section; lanes the dead rules already classify stay there.
    const byName = new Map(branchList.map(b => [b.name, b]));
    const hidden: BranchLane[] = [];
    for (const name of modeDead.keys()) {
      if (baseDeadNames.has(name)) continue;
      const b = byName.get(name);
      if (b) hidden.push(b);
    }
    return { hidden, archived: merge('archived'), dormant: merge('dormant') };
  }, [inactive, rangeEmpty, modeDead, baseDeadNames, branchList]);
  const allDeadNames = useMemo(() => {
    const s = new Set<string>();
    for (const l of mergedGroups.hidden) s.add(l.name);
    for (const l of mergedGroups.archived) s.add(l.name);
    for (const l of mergedGroups.dormant) s.add(l.name);
    return s;
  }, [mergedGroups]);

  // Fetch patch links when the Copies toggle is on and a repo is loaded.
  useEffect(() => {
    if (!showPatchLinks || !gitData) {
      setPatchLinks([]);
      return;
    }
    let cancelled = false;
    setPatchLinksLoading(true);
    getPatchLinks(repoId)
      .then(links => { if (!cancelled) setPatchLinks(links ?? []); })
      .catch(() => { if (!cancelled) setPatchLinks([]); })
      .finally(() => { if (!cancelled) setPatchLinksLoading(false); });
    return () => { cancelled = true; };
  }, [showPatchLinks, gitData, repoId]);

  // Diff volume (node sizing) loads lazily after the first paint — one
  // tree diff per key commit is too expensive to block the open path on.
  // Stats are a pure function of the commit id, so merging late-arriving
  // results into a newer view is still correct.
  const loadDiffStats = useCallback((data: GitData) => {
    // Newest first: the backend caps at 150 and recent key commits are what
    // the user is looking at. Skip commits that already have stats filled.
    const ids = data.commits
      .filter(c => c.is_key && c.additions + c.deletions === 0)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(c => c.id);
    if (ids.length === 0) return;
    getCommitStats(repoId, ids)
      .then(stats => {
        // An empty response (nothing new since the last merge) must not
        // clone the whole commit array: a fresh gitData object re-runs the
        // entire display pipeline AND a full scene redraw for no visual
        // change — this landed right after every fetch-triggered refresh,
        // doubling its rebuild.
        if (stats.length === 0) return;
        const byId = new Map(stats.map(s => [s.id, s]));
        setGitData(prev => prev && ({
          ...prev,
          commits: prev.commits.map(c => {
            const s = byId.get(c.id);
            return s ? { ...c, additions: s.additions, deletions: s.deletions } : c;
          }),
        }));
      })
      .catch(() => {});
  }, [repoId]);

  // Rebuild the backend view for a branch subset. Declared ABOVE the
  // selection-restore effect below: it calls this for the M2.4 restore,
  // and a useCallback dep array is read during render, so a later
  // declaration would be a TDZ error (the M1.3 landmine).
  // filterBusy feeds Timeline's render badge through the delay gate; the
  // try/finally wraps the whole body so every exit path drops it.
  const [filterBusy, setFilterBusy] = useState(false);
  const handleFilterChange = useCallback(async (branchNames: string[]) => {
    setSelectedBranches(branchNames);
    setFilterBusy(true);
    try {
      const effective = hideRemotes ? pruneRemoteLanes(branchNames, remoteLaneNames) : branchNames;
      const data = await filterByBranches(repoId, effective);
      setGitData(data);
      loadDiffStats(data);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    } finally {
      setFilterBusy(false);
    }
  }, [repoId, hideRemotes, remoteLaneNames, loadDiffStats]);

  // The remotes toggle is lane-level: flipping it rebuilds the view with
  // the remote-only lanes pruned (ON) or restored (OFF). The chip selection
  // itself is untouched — only what goes to the backend is pruned.
  const hideRemotesRef = useRef(hideRemotes);
  useEffect(() => {
    if (hideRemotesRef.current === hideRemotes) return;
    hideRemotesRef.current = hideRemotes;
    void handleFilterChange(selectedBranches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideRemotes, handleFilterChange]);

  // Mount-time tail of the old open flow (Task 5): App opened the repo
  // and handed us initialData; the chip list and the M2.4 selection
  // restore are this view's own first-mount work. Runs once per mount --
  // every dependency (repoId, path, loadDiffStats, handleFilterChange) is
  // stable for the tab's lifetime.
  useEffect(() => {
    let cancelled = false;
    // Remembered date scope (viewpersist.ts), restored before the first
    // rangedData memo runs: the view opens already cropped the way the user
    // left it, custom inputs' strings included.
    const savedRange = loadDateRange(path);
    if (savedRange) {
      setDateRange(savedRange.range);
      setCustomFrom(savedRange.customFrom);
      setCustomTo(savedRange.customTo);
    }
    loadDiffStats(initialData);
    (async () => {
      try {
        const branches = await getBranchList(repoId);
        if (cancelled) return;
        setBranchList(branches);
        // Include-set is SESSION-ONLY and starts FULL: every mount shows the
        // whole repo, so branches that appeared since the last visit (fetch,
        // colleague push) are simply there. The old persisted inclusion
        // snapshot restored a frozen branch list and locked every newer
        // branch out of the view forever (the freshness report).
        // Day-to-day personalization lives in the stars (persisted) and the
        // one-click view modes.
        setSelectedBranches(branches.map(b => b.name));
        // Stale stars prune against this list via the branchList effect
        // below (the stars themselves came from lazy storage init).
      } catch (err) {
        recordFrontendError(errText(err));
        if (!cancelled) setError(errText(err));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changing the stale-branches setting rebuilds the backend session under
  // the new policy via set_include_stale (Task 5): the unified dedup
  // forbids the old re-open path -- already_open never resets a session.
  // The reset sweep mirrors the old re-open exactly (stale lanes change,
  // so panel state and the session window reseed).
  const staleSettingRef = useRef(showStaleBranches);
  useEffect(() => {
    if (staleSettingRef.current === showStaleBranches) return;
    staleSettingRef.current = showStaleBranches;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const data = await setIncludeStale(repoId, showStaleBranches);
        if (cancelled) return;
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        setComparePair(null);
        setCheckoutDialog(null);
        setSwitchedBranch(null);
        setExpandedDead(new Set());
        setUserCollapsed(new Set());
        setViewMode('all');
        setViewResetKey(k => k + 1);
        setDateRange({ kind: 'all' });
        setCustomFrom('');
        setCustomTo('');

        const branches = await getBranchList(repoId);
        if (cancelled) return;
        setBranchList(branches);
        setSelectedBranches(branches.map(b => b.name));
        // Stale stars prune via the branchList effect below.
        setSearchQuery('');
        setLocateQuery('');
        setLocateOpen(false);
      } catch (err) {
        recordFrontendError(errText(err));
        if (!cancelled) setError(errText(err));
      }
    })();
    return () => { cancelled = true; };
  }, [showStaleBranches, repoId, path, loadDiffStats, handleFilterChange]);

  // Background refresh when the repo changed outside gtv (terminal git
  // commands, editor, another tool — the watcher.rs poller emits
  // "repo-changed"). This must not yank the user's context: keep the
  // selection when its commit survived, keep the viewport (no viewResetKey
  // bump), keep expanded lanes and filters. Loaded-older pagination state
  // is rebuilt from scratch — accepted v1 limitation. Rebased/amended
  // commits get new oids, so stale selections drop naturally.
  // The full-view rebuild goes through refreshRepository (Task-5 review
  // 3c): the one command that re-reads the view from HEAD under the
  // session's current policy without touching the terminal or the watcher
  // baseline (a re-open is forbidden by the dedup semantics and would just
  // return the stale session view). A narrowed branch selection rebuilds
  // through filterByBranches instead -- refreshRepository only knows the
  // full seed set, so routing a subset through it would flash every lens
  // back to all lanes. setIncludeStale went back to serving only the
  // settings toggle.
  const refreshingRef = useRef(false);
  // Deliberately NO UI twin of refreshingRef: the background refresh swaps
  // data in place around a stable camera and must stay SILENT -- feeding it
  // to Timeline's delay-gated render badge made every auto-fetch-triggered
  // refresh dim the whole graph (the VS Code flicker report). Re-entry is
  // gated by the ref alone.
  // Set when a change event arrives while a refresh is in flight: the
  // running refresh's finally replays the latest handler once, so a
  // one-shot event (branch delete) is never dropped.
  const refreshPendingRef = useRef(false);
  // Declared before handleRepoRefresh so its finally can replay through
  // this ref (the debounced listener below uses it too).
  const refreshHandlerRef = useRef<() => Promise<void>>(async () => {});
  const handleRepoRefresh = useCallback(async () => {
    if (refreshingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshingRef.current = true;
    // A pending checkout confirm holds preflight counts this rebuild just
    // invalidated -- close it (the world changed, re-ask) instead of
    // letting the user confirm against stale numbers. SAFE checkout stays
    // the correctness backstop either way.
    setCheckoutDialog(null);
    try {
      const keepId = selectedCommit?.id ?? null;
      // refreshRepository always rebuilds the FULL view from every seed,
      // so a narrowed selection (pinned/recent lens, chip filter,
      // related-only) would flash back to all lanes on every refresh.
      // Prune the selection against the fresh branch list first, then
      // re-narrow through filterByBranches when it is a real subset.
      // The include-set is "what the user removed", NOT a frozen snapshot:
      // branches that appeared since the last refresh (a fetch brought in
      // origin/x, a colleague pushed a branch) JOIN the view — leaving
      // them out made every fetch look like a no-op (the freshness
      // report). "全部" remains the way back to the complete set.
      const listed = await getBranchList(repoId);
      const listedNames = new Set(listed.map(b => b.name));
      const kept = selectedBranches.filter(n => listedNames.has(n));
      const added = listed
        .filter(b => !selectedBranches.includes(b.name))
        .map(b => b.name);
      const selection = kept.length ? [...kept, ...added] : listed.map(b => b.name);
      // The remotes toggle hides remote-only lanes at the lane level too:
      // a full local-only selection counts as narrowed, so the refresh
      // goes through the (closure-anchored) filter path.
      const remoteNames = hideRemotes
        ? new Set(listed.filter(b => b.is_remote).map(b => b.name))
        : null;
      const effective = remoteNames ? pruneRemoteLanes(selection, remoteNames) : selection;
      const narrowed = effective.length < listed.length;
      const data = narrowed
        ? await filterByBranches(repoId, effective)
        : await refreshRepository(repoId);
      setGitData(data);
      loadDiffStats(data);
      if (keepId && data.commits.some(c => c.id === keepId)) {
        try {
          setSelectedCommit(await getCommitDetail(repoId, keepId));
        } catch {
          setSelectedCommit(null);
        }
      } else {
        setSelectedCommit(null);
      }
      const branches = await getBranchList(repoId);
      setBranchList(branches);
      const names = new Set(branches.map(b => b.name));
      const stillKept = selection.filter(n => names.has(n));
      setSelectedBranches(stillKept.length ? stillKept : branches.map(b => b.name));
      // Ref changes often accompany worktree churn (checkout/pull) — keep
      // the cleanliness marker in step with the rebuilt view.
      getWorktreeStatus(repoId).then(setWtStatus).catch(() => {});
    } catch (err) {
      // A transient failure (e.g. racing a repo being replaced) must not
      // nuke the view. A one-shot change (branch delete) has no next event,
      // so the pending replay above is the retry path for dropped events.
      recordFrontendError(errText(err));
    } finally {
      refreshingRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        void refreshHandlerRef.current();
      }
    }
  }, [repoId, selectedCommit, selectedBranches, hideRemotes, loadDiffStats]);
  useEffect(() => {
    refreshHandlerRef.current = handleRepoRefresh;
  }, [handleRepoRefresh]);

  // Manual fetch (header button): one explicit `git fetch --all` against
  // THIS tab's repo -- the same write surface as the 60 s auto-fetch,
  // user-initiated. A clean result refreshes the view immediately through
  // the shared refresh path (the watcher's poll would catch the moved
  // tracking refs a moment later anyway; refreshing here is what makes
  // the button feel alive). A failure summary becomes a transient toast
  // instead of the error strip: offline is expected, not an app error.
  const handleFetch = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const summary = await fetchRepository(repoId);
      if (summary) {
        setFetchToast({ ok: false, text: t('fetchFailed', { summary }) });
      } else {
        await handleRepoRefresh();
        setFetchToast({ ok: true, text: t('fetchDone') });
      }
    } catch (err) {
      recordFrontendError(errText(err));
    } finally {
      setFetching(false);
    }
  }, [fetching, repoId, handleRepoRefresh, t]);

  // Debounce "repo-changed" bursts (rebase/fetch fire several) into one
  // refresh. Events are filtered on payload.repo_id (T1 review Low-2):
  // sibling tabs run their own listeners, and no emit ORDER is assumed --
  // each event for THIS repo independently restarts the debounce. The
  // handler lives in a ref so resubscription only happens when the repo
  // itself changes, not on every selection.
  const repoRefreshTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    let un: (() => void) | null = null;
    try {
      listen<RepoChanged>('repo-changed', (e) => {
        if (e.payload?.repo_id !== repoId) return;
        window.clearTimeout(repoRefreshTimer.current);
        repoRefreshTimer.current = window.setTimeout(() => {
          if (!dead) void refreshHandlerRef.current();
        }, 500);
      })
        .then(fn => {
          if (dead) fn();
          else un = fn;
        })
        .catch(() => {});
    } catch {
      // browser mock preview: no event API
    }
    return () => {
      dead = true;
      un?.();
      window.clearTimeout(repoRefreshTimer.current);
    };
  }, [repoId]);

  // Page in the next chunk of older history. The backend re-lays out the
  // whole loaded set; Timeline keeps the viewport anchored (no resetKey bump).
  const [loadingOlder, setLoadingOlder] = useState(false);
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !gitData?.has_more) return;
    setLoadingOlder(true);
    try {
      const data = await loadOlderCommits(repoId);
      if (!data) return;
      setGitData(data);
      loadDiffStats(data);
      // Paging may have reached a previously stale branch tip: new lanes
      // mean the chip list needs a refresh (lane colors come from the view).
      if (data.branches.length !== gitData.branches.length) {
        const branches = await getBranchList(repoId);
        setBranchList(branches);
      }
    } catch (err) {
      recordFrontendError(errText(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, gitData, repoId, loadDiffStats]);

  const handleCommitClick = useCallback(async (commitId: string) => {
    try {
      const detail = await getCommitDetail(repoId, commitId);
      setSelectedCommit(detail);
    } catch (err) {
      console.error('Failed to get commit detail:', err);
      recordFrontendError(errText(err));
    }
  }, [repoId]);

  const handleCloseDetails = useCallback(() => {
    setSelectedCommit(null);
    setDetailsWide(false);
  }, []);

  // Empty-canvas click closes the details slot (the canvas acts as the
  // panel's "outside"): the whole slot clears, whatever it holds -- a
  // half-open compare pair included? NO: plain-canvas mirrors plain-node
  // semantics minus the selection, and a pending HALF-pair (target '')
  // survives plain clicks by spec 4.4. A COMPLETE pair is an open panel:
  // it closes. Timeline filters pan-drag endings; nodes/edges stop
  // propagation, so this fires for genuinely empty canvas only.
  const handleCanvasClick = useCallback(() => {
    setComparePair(p => (p && p.target !== '' ? null : p));
    handleCloseDetails();
  }, [handleCloseDetails]);

  // Plain NODE click (Timeline only) = exit compare + open single-commit
  // details (spec 4.4 panel-competition rule). Deliberately a wrapper
  // around handleCommitClick rather than a line inside it: arrow-key
  // stepping also calls handleCommitClick, and stepping must NOT touch
  // comparePair (spec 4.4 -- with the compare panel open, arrows move
  // the selection underneath it; the pair survives).
  const handleNodeClick = useCallback((commitId: string) => {
    setComparePair(null);
    handleCommitClick(commitId);
  }, [handleCommitClick]);

  // Ctrl/Cmd+click node pairing (spec 4.4): nextPair owns every
  // transition (idle/complete -> new base; half -> fills the target) --
  // App only stores the result.
  const handleCompareClick = useCallback((commitId: string) => {
    setComparePair(p => nextPair(p, commitId));
  }, []);

  // Lane-menu "compare with HEAD": headToLaneTip already produced a
  // COMPLETE pair (base = HEAD, target = lane tip).
  const handleComparePair = useCallback((pair: ComparePair) => {
    setComparePair(pair);
  }, []);

  const handleCloseCompare = useCallback(() => {
    setComparePair(null);
    setDetailsWide(false);
  }, []);

  // Half-pair marker for the canvas: the pending base is ringed only
  // while the pair is incomplete -- a complete pair opens the panel.
  const compareBaseId = comparePair && comparePair.target === '' ? comparePair.base : null;

  // Half-pair repair (single point, mirrors the selectedCommit keep-if-
  // survived logic in handleRepoRefresh): any rebuild -- watcher refresh,
  // view-from-branch, chip filtering, a locate jump -- can drop the
  // pending base out of the loaded set. The canvas ring then vanishes
  // (Timeline filters by loaded node ids) while the pair survives, and the
  // next ctrl+click would complete a pair against an invisible base.
  // COMPLETE pairs are deliberately left alone: the panel resolves both
  // oids via the backend's resolve_commit straight into the object db,
  // independent of the loaded window (verified in the M3 final review).
  useEffect(() => {
    setComparePair(p =>
      p && p.target === '' && gitData && !gitData.commits.some(c => c.id === p.base)
        ? null
        : p
    );
  }, [gitData]);

  // M2.1 lane-menu action: rebuild the view with only the target lane's
  // blood-line closure. The closure is computed from the RAW gitData -- the
  // display copy (view) collapses lanes and rewrites lane_index, while the
  // walk needs the full window structure; names are stable either way.
  const handleRelatedBranch = useCallback((name: string) => {
    if (!gitData) return;
    handleFilterChange([...relatedLanes(gitData, name)]);
  }, [gitData, handleFilterChange]);

  const handleViewFromBranch = useCallback(async (branchName: string) => {
    setError(null);
    try {
      const data = await switchBranch(repoId, branchName);
      setGitData(data);
      loadDiffStats(data);
      setSelectedCommit(null);
      // The viewed branch is the user's focus: it starts expanded, and any
      // display narrowing (view mode, manual folds) stands down -- a
      // deliberate re-anchor shows the whole map.
      setExpandedDead(new Set([branchName]));
      setUserCollapsed(new Set());
      setViewMode('all');
      setViewResetKey(k => k + 1);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    }
  }, [repoId, loadDiffStats]);

  // M3.1 checkout (spec 4.2). After a successful checkout the app does
  // NOTHING else to the view -- no setGitData, no refresh call: the
  // repo-changed watcher (1.5s poll + 500ms debounce -> handleRepoRefresh)
  // is the ONE rebuild path (spec 4.3, arc invariant). Declared above
  // handleCheckoutBranch, which depends on it (the M1.3 TDZ rule).
  const doCheckout = useCallback(async (branch: string) => {
    setError(null);
    // Optimistic close (final review L3): the dialog drops the moment
    // confirm is clicked -- its preflight counts were what the user just
    // consented to -- and the unmount doubles as the double-click guard
    // (a second click lands on nothing). Failure re-surfaces through the
    // error banner below, never by re-opening the dialog.
    setCheckoutDialog(null);
    try {
      await checkoutBranch(repoId, branch);
      setSwitchedBranch(branch);
    } catch (err) {
      // The backend text already states the set_head half-success
      // residual state honestly.
      recordFrontendError(errText(err));
      setError(errText(err));
    }
  }, [repoId]);

  // Lane-menu "check out this branch": preflight the worktree, then either
  // confirm (dirty) or switch right away (clean). Checking out the CURRENT
  // branch goes through unchanged too (git semantics: safe no-op, spec 5).
  const handleCheckoutBranch = useCallback(async (branch: string) => {
    try {
      const status = await getWorktreeStatus(repoId);
      if (status.merge_in_progress) {
        // No confirm path around an in-progress merge/cherry-pick/revert.
        setError(t('mergeInProgress'));
        return;
      }
      // Untracked alone counts as dirty: an untracked file at a path the
      // target tracks makes a safe checkout fail, so it must be confirmed.
      if (status.modified > 0 || status.untracked > 0) {
        setCheckoutDialog({ branch, status });
        return;
      }
      await doCheckout(branch);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    }
  }, [t, doCheckout]);

  // Success hint is transient: auto-hide after a few seconds. The cleanup
  // clears the timer on unmount and on a fresh switch (re-triggered effect).
  useEffect(() => {
    if (!switchedBranch) return;
    const timer = window.setTimeout(() => setSwitchedBranch(null), 4000);
    return () => window.clearTimeout(timer);
  }, [switchedBranch]);

  // Copy toast is even more transient (it confirms, it does not narrate).
  useEffect(() => {
    if (!copyToast) return;
    const timer = window.setTimeout(() => setCopyToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copyToast]);

  // Fetch toast: failures linger a little longer (they carry git's one-line
  // reason), the clean confirmation matches the copy toast's brevity.
  useEffect(() => {
    if (!fetchToast) return;
    const timer = window.setTimeout(() => setFetchToast(null), fetchToast.ok ? 1600 : 5000);
    return () => window.clearTimeout(timer);
  }, [fetchToast]);

  // Copy a ref name (chip right-click, panel row button). The async
  // clipboard API can be denied inside the WKWebView embed; the legacy
  // execCommand path covers that. Either way the toast reports the result.
  const copyName = useCallback(async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopyToast({ name, ok: true });
      return;
    } catch {
      // Fall through to the legacy path.
    }
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = name;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {
      // ok stays false
    }
    setCopyToast({ name, ok });
  }, []);

  // (Header lane chips are gone: the canvas labels already carry lane
  // identity and the ref panel owns per-lane control, so the header no
  // longer needs a per-lane toggle -- the panel's applyZoneToggle is the
  // one selection verb now.)

  // The include-set is deliberately NOT persisted (the old M2.4 snapshot
  // locked newer branches out of the view); every mount starts full and a
  // refresh unions branches that appeared meanwhile. See the mount effect.

  // Pin marks persist unconditionally, empty set included (unpinning the
  // last branch is real state; skipping the write would resurrect the old
  // set on reload).
  useEffect(() => {
    savePinned(path, pinnedBranches);
  }, [path, pinnedBranches]);

  // Stale stars drop as branches disappear: prune the pin set against the
  // live branch list on every change. A deleted branch must not leave a
  // zombie star in storage -- a same-named branch created later would
  // resurrect it -- and the manager's ★ section reads the same state. The
  // save effect above persists the pruned set. The empty-list bail matters:
  // branchList starts [] and fills asynchronously, and pruning against the
  // initial empty list would wipe the lazy-loaded stars before the first
  // real list lands (the same race the lazy init fixed).
  useEffect(() => {
    if (branchList.length === 0) return;
    setPinnedBranches(prev => {
      const avail = new Set(branchList.map(b => b.name));
      const next = prev.filter(n => avail.has(n));
      return next.length === prev.length ? prev : next;
    });
  }, [branchList]);

  // Date-scope persistence (viewpersist.ts): the remembered window rides
  // with the repo, not the session -- "last week" survives a webview reload
  // and a restart. Every change is written, including the stale-toggle
  // sweep's reset to 'all' (an explicit policy change; resetting the memory
  // matches the sweep's old re-open semantics).
  useEffect(() => {
    saveDateRange(path, { range: dateRange, customFrom, customTo });
  }, [path, dateRange, customFrom, customTo]);

  const togglePin = useCallback((name: string) => {
    setPinnedBranches(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  }, []);

  // Dead-lane chips toggle VISIBILITY ONLY: they never touch the lane
  // selection, so the lane stays inside selectedBranches and every
  // filterByBranches rebuild keeps it loaded (collapse is pure display).
  const toggleDeadLane = useCallback((name: string) => {
    setExpandedDead(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  // Group toggle (spec §4.3 expand/collapse): expanding is the common case,
  // but one misclick on a 500-lane sediment row must be reversible without
  // reopening the repo — when EVERY lane of the group is expanded, the same
  // click collapses them all back into the trace row.
  const expandTraceGroup = useCallback((kind: SedimentKind) => {
    setExpandedDead(prev => {
      const group = mergedGroups[kind];
      const collapse = group.length > 0 && group.every(l => prev.has(l.name));
      const next = new Set(prev);
      for (const l of group) {
        if (collapse) next.delete(l.name); else next.add(l.name);
      }
      return next;
    });
  }, [mergedGroups]);

  // Action label follows the toggle state ("Collapse" once every lane of the
  // group is expanded). One helper feeds both the panel group buttons and
  // Timeline's trace-chip titles, so they can never disagree.
  const traceGroupLabel = useCallback((kind: SedimentKind) => {
    const group = mergedGroups[kind];
    const expanded = group.length > 0 && group.every(l => expandedDead.has(l.name));
    return t(expanded ? 'collapseGroup' : 'expandGroup');
  }, [mergedGroups, expandedDead, t]);

  // Latest activity time per ref: see the memo above the pipeline (the
  // `active` view mode reads it too).
  const sortedBranches = useMemo(() => {
    return [...branchList].sort((a, b) =>
      (refActivity.get(b.name) ?? 0) - (refActivity.get(a.name) ?? 0));
  }, [branchList, refActivity]);

  // Active-only ref view, TWO DOMAINS with one boundary: the header owns
  // the state at rest, the panel owns the search. activeBranches
  // deliberately does NOT see searchQuery — the old chain let the
  // panel's search box live-filter the toolbar chips uninvited, and
  // once matches fell under the inline limit the "+N more" entry
  // vanished with the query never reset, stranding the toolbar in a
  // filter the user could no longer reach or clear. Dead lanes never
  // appear in the live panel sections (they live in the Archived/
  // Dormant groups, which keep their own counts), so every count the
  // header shows — the filter-status pill's subset count included —
  // derives from this list.
  const activeBranches = useMemo(
    () => sortedBranches
      .filter(b => showTags || !b.is_tag)
      .filter(b => !hideRemotes || !b.is_remote)
      .filter(b => !allDeadNames.has(b.name)),
    [sortedBranches, showTags, hideRemotes, allDeadNames]
  );


  // --- lane manager rows -----------------------------------------------------
  // Single-list manager (the transfer zones are gone): the sections render
  // in this order — ★ starred, then alive branches — and the search field's
  // keyboard walk follows the same order. Include/exclude (the LOADED set)
  // is the ADVANCED verb here: day-to-day narrowing lives on the canvas
  // (fold / view modes), so rows keep their checkboxes but no drag, no
  // FLIP, no second list to read.
  const starredBranches = useMemo(
    () => pinnedBranches
      .map(name => sortedBranches.find(b => b.name === name))
      .filter((b): b is BranchLane => !!b && !b.is_tag),
    [pinnedBranches, sortedBranches]
  );
  const starredSet = useMemo(() => new Set(pinnedBranches), [pinnedBranches]);
  // Starred quick bar: starred lanes resolved to their BranchLane (for the
  // lane colors), capped in the header; the overflow opens the manager.
  const STAR_DOT_MAX = 7;
  const starDots = starredBranches.slice(0, STAR_DOT_MAX);
  const starredOverflow = Math.max(0, starredBranches.length - STAR_DOT_MAX);
  const matchesSearch = useCallback(
    (b: BranchLane) => !searchQuery || b.name.toLowerCase().includes(searchQuery.toLowerCase()),
    [searchQuery]
  );
  const mgrStarredRows = useMemo(
    () => starredBranches.filter(matchesSearch),
    [starredBranches, matchesSearch]
  );
  const mgrBranchRows = useMemo(() => {
    const rows: BranchLane[] = [];
    for (const b of activeBranches) {
      if (starredSet.has(b.name) || !matchesSearch(b)) continue;
      rows.push(b);
    }
    return rows;
  }, [activeBranches, starredSet, matchesSearch]);
  // The keyboard walk's flat order = the visual section order.
  const mgrRows = useMemo(() => [...mgrStarredRows, ...mgrBranchRows], [mgrStarredRows, mgrBranchRows]);
  const highlightedRefName = showAllTags && mgrRows.length > 0
    ? mgrRows[Math.min(rowHighlight, mgrRows.length - 1)].name
    : null;

  // Footer count = the GLOBAL answer ("how many lanes is the canvas
  // drawing"), so it deliberately ignores the panel query. Dead lanes
  // never render as lanes (they live in their own groups and only
  // surface through trace expansion), so they are excluded here.
  const selectedActiveCount = useMemo(() => {
    const selected = new Set(selectedBranches);
    return activeBranches.filter(b => selected.has(b.name)).length;
  }, [activeBranches, selectedBranches]);

  // Include/exclude from the LOADED set — the manager panel's ADVANCED
  // verb (the zone drag-and-drop and its FLIP animation are gone; the
  // day-to-day narrowing verbs are fold and the view modes, both instant).
  const toggleInclude = useCallback((names: string[], select: boolean) => {
    if (select) {
      handleFilterChange([...new Set([...selectedBranches, ...names])]);
    } else {
      const drop = new Set(names);
      handleFilterChange(selectedBranches.filter(n => !drop.has(n)));
    }
  }, [selectedBranches, handleFilterChange]);

  // Map-model canvas verbs: fold a lane into its sediment row (instant,
  // session-only), and "全部" -- the one HEAVY verb in the header trio,
  // because include was the only state that could actually remove lanes
  // from the backend view. It restores the full loaded set and clears
  // every display-level fold.
  const foldLane = useCallback((name: string) => {
    setUserCollapsed(prev => new Set(prev).add(name));
  }, []);
  const resetLanes = useCallback(() => {
    setViewMode('all');
    setUserCollapsed(new Set());
    handleFilterChange(branchList.map(b => b.name));
  }, [branchList, handleFilterChange]);

  // Dead-lane panel groups (newest activity first, matching the rows
  // above). The search box filters them too: a lane collapsed into the
  // sediment is exactly the one a user goes looking for by name.
  const byActivity = (a: BranchLane, b: BranchLane) =>
    (refActivity.get(b.name) ?? 0) - (refActivity.get(a.name) ?? 0);
  const deadNameMatches = useCallback(
    (b: BranchLane) => !searchQuery || b.name.toLowerCase().includes(searchQuery.toLowerCase()),
    [searchQuery]
  );
  const deadSectionRows = useCallback(
    (kind: SedimentKind): BranchLane[] =>
      [...mergedGroups[kind]].filter(deadNameMatches).sort(byActivity),
    [mergedGroups, refActivity, deadNameMatches]
  );

  // Header search results: instant loaded-range matches merged with the
  // debounced backend hits (mergeLocate dedupes, orders, and caps). The
  // dropdown renders everything up to SEARCH_LIMIT in a scrollable list —
  // the cap is the backend's, not a "top few only" wall.
  const locateResults = useMemo((): LocateResult[] => {
    // Search what you see: matchLoaded runs over the date-windowed data,
    // so cropped commits stop matching. Remote full-history hits keep
    // coming, but one outside the current window is demoted to in_view
    // false and takes the existing "view from this commit" jump path.
    // Foreign lineage (lane_owner "" — deselected branches' commits) is
    // hidden from the canvas, so it never matches as in-view either.
    const foreignIds = new Set(
      (rangedData?.commits ?? []).filter(c => c.lane_owner === '').map(c => c.id),
    );
    const remote = dateRange.kind === 'all'
      ? remoteHits.filter(h => !foreignIds.has(h.id))
      : remoteHits
          .filter(h => !foreignIds.has(h.id))
          .map(h => ({ ...h, in_view: h.in_view && !outOfRange.has(h.id) }));
    return mergeLocate(
      matchLoaded(
        (rangedData?.commits ?? []).filter(c => c.lane_owner !== ''),
        rangedData?.branches ?? [],
        locateQuery,
        hideRemotes,
      ),
      remote,
      SEARCH_LIMIT,
    );
  }, [rangedData, dateRange, outOfRange, locateQuery, remoteHits, hideRemotes]);

  // With up to SEARCH_LIMIT rows, keyboard navigation must keep the
  // highlighted row inside the dropdown's scrollable area.
  useEffect(() => {
    if (!locateOpen) return;
    document.querySelector('.locate-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [locateIndex, locateOpen, locateResults]);

  // Preview-on-highlight: the commit detail panel follows the highlighted
  // dropdown row (arrow keys or hover) WITHOUT committing — no jump, no view
  // switch, the dropdown stays open for scanning. Enter still commits.
  // Debounced so arrowing through the list doesn't burst IPC calls; the
  // cancelled flag drops responses that are no longer the highlighted row.
  useEffect(() => {
    if (!locateOpen) return;
    const r = locateResults[locateIndex];
    if (!r) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getCommitDetail(repoId, r.kind === 'branch' ? r.commitId : r.id)
        .then(d => { if (!cancelled) setSelectedCommit(d); })
        .catch(() => {});
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [locateOpen, locateIndex, locateResults, repoId]);

  // Full-history search: debounce the query, ask the backend, drop stale
  // responses (cancelled flag). <2 chars skips the call — the loaded-range
  // matcher still runs instantly in the memo below.
  useEffect(() => {
    const q = locateQuery.trim();
    if (!gitData || q.length < 2) {
      setRemoteHits([]);
      setRemotePending(false);
      return;
    }
    let cancelled = false;
    setRemotePending(true);
    const timer = setTimeout(() => {
      searchCommits(repoId, q, SEARCH_LIMIT)
        .then(hits => { if (!cancelled) { setRemoteHits(hits ?? []); setRemotePending(false); } })
        .catch(() => { if (!cancelled) { setRemoteHits([]); setRemotePending(false); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [locateQuery, gitData, repoId]);

  // Cmd/Ctrl + F toggles the floating search over the graph. Active tab
  // only: kept-alive siblings register the same listener and must stay
  // silent (one shortcut, one action, regardless of tab count).
  const locateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        if (!gitData || !active) return;
        e.preventDefault();
        setLocateOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gitData, active]);
  useEffect(() => {
    if (locateOpen) locateInputRef.current?.focus();
  }, [locateOpen]);
  // Esc closes the floating search from ANY focus position. The input's
  // own Escape branch below only fires while the input holds focus, but a
  // scan (hover/arrow preview, a click into the graph or a node) hands
  // focus elsewhere -- then Esc did nothing and the float hung over the
  // canvas. While the float is open it is the TOPMOST Esc consumer: the
  // compare-panel and ref-panel Esc handlers bail while locateOpen, so Esc
  // peels one layer per press. An IME composition owns Esc first (it
  // cancels the pinyin), so a composing keydown never closes the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || e.key !== 'Escape' || !locateOpen || e.isComposing) return;
      setLocateOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, locateOpen]);

  // Keep the keyboard-highlighted ref row inside the panel's scroll area
  // (same contract as the locate dropdown's highlight effect above). Safe
  // as a document query: only the active tab can hold an open panel (the
  // deactivate effect closes everyone else's), and .hl renders only while
  // the panel is open, so at most one match exists.
  useEffect(() => {
    if (!showAllTags) return;
    document.querySelector('.mgr-row.hl')?.scrollIntoView({ block: 'nearest' });
  }, [rowHighlight, showAllTags]);

  // Opening the manager puts the cursor in its search field (the header
  // trigger is a button now; "/" opens AND focuses through this effect).
  useEffect(() => {
    if (showAllTags) filterInputRef.current?.focus();
  }, [showAllTags]);

  // ←/→ step to the previous/next commit on the SAME lane while the
  // detail panel is open. commits are in ascending (time, topo) order —
  // i.e. visual left→right — so index ±1 is the visual neighbor.
  // Active tab only (same multi-instance gate as the handlers above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !selectedCommit || !gitData) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const current = gitData.commits.find(c => c.id === selectedCommit.id);
      if (!current) return;
      // Walk visible commits only: collapsed-lane commits are hidden from
      // the canvas and the date window cropped the rest -- stepping into
      // either would focus empty space.
      const lane = gitData.commits.filter(
        c => c.lane_owner === current.lane_owner
          && !hiddenIds.has(c.id) && !outOfRange.has(c.id),
      );
      const i = lane.findIndex(c => c.id === current.id);
      const next = e.key === 'ArrowRight' ? lane[i + 1] : lane[i - 1];
      if (!next) return;
      e.preventDefault();
      focusSeqRef.current += 1;
      setFocusTarget({ id: next.id, seq: focusSeqRef.current });
      handleCommitClick(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, selectedCommit, gitData, handleCommitClick, hiddenIds, outOfRange]);

  // Esc peels the right-side panel slot one layer per press: a COMPLETE
  // compare pair closes first, then the plain details panel (the user
  // asked for a keyboard quick-hide; the × was mouse-only). A half-pair
  // (target '') is not an open panel -- Esc leaves it for a plain click or
  // the next ctrl+click to resolve (spec 4.4). While the wide split view
  // is open, Esc belongs to IT (collapse to the narrow panel first; the
  // next Esc closes the panel). Inputs keep their own Esc handling (locate
  // dropdown), so typing in one never closes the panel behind it. Active
  // tab only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // locateOpen first: the floating search sits above the panel and owns
      // the Esc -- one press peels it, the NEXT press closes the pair.
      if (!active || e.key !== 'Escape' || detailsWide || locateOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      // A COMPLETE pair is an open panel: Esc closes it. A half-pair is
      // not (spec 4.4) -- it falls through, so the press can close the
      // details panel underneath instead.
      if (comparePair && comparePair.target !== '') {
        setComparePair(null);
        return;
      }
      // The plain details panel has no other keyboard exit; its × is
      // mouse-only.
      if (selectedCommit) {
        setSelectedCommit(null);
        setDetailsWide(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, comparePair, detailsWide, locateOpen, selectedCommit]);

  // H = "go home" (Age of Empires): snap the camera back to HEAD. Plain H
  // only — with Cmd/Ctrl it means something else (Cmd+H hides the window,
  // Ctrl+H is history in some editors). INPUT/TEXTAREA bail: typing in the
  // locate box must not jump, and the integrated terminal's xterm owns a
  // TEXTAREA, so an 'h' meant for the shell never triggers the camera.
  // Active tab only (same multi-instance gate as the handlers above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !gitData) return;
      if (e.key !== 'h' && e.key !== 'H') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      setHeadSignal(n => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, gitData]);

  // "/" opens the lane manager with its search focused (the Gmail/HE idiom:
  // plain slash = "filter what I'm looking at"). Same guards as H: no
  // modifiers, bail on inputs (a '/' typed into the locate box or the
  // terminal must not move focus), active tab only. The effect above puts
  // the cursor in the panel's search field once it exists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !gitData) return;
      if (e.key !== '/') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      setShowAllTags(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, gitData]);

  // Esc closes the ref panel when focus is NOT inside the filter field --
  // the field owns a two-step exit (clear the query first, then close), so
  // this handler must not second-guess it. The input bail is TEXT inputs
  // only (plus the field itself): a row checkbox is also an INPUT, and
  // bailing on it would leave Esc dead after the very first row click.
  // Active tab only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // locateOpen first: the floating search sits above the panel and owns
      // the Esc -- one press peels it, the NEXT press closes the panel.
      // The right-side details/compare slot sits between the two: while it
      // is open it consumes the press (its own handler above), so Esc
      // always peels exactly one layer.
      if (!active || e.key !== 'Escape' || !showAllTags || locateOpen || detailsWide) return;
      if ((comparePair && comparePair.target !== '') || selectedCommit) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (el === filterInputRef.current) return;
      if (el.tagName === 'TEXTAREA') return;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox') return;
      closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, showAllTags, locateOpen, detailsWide, comparePair, selectedCommit, closePanel]);

  const handleLocate = useCallback(async (r: LocateResult) => {
    const id = r.kind === 'branch' ? r.commitId : r.id;
    setLocateQuery('');
    setLocateOpen(false);
    if (r.kind === 'commit' && !r.in_view) {
      // Hit outside the loaded window: swap the view to the target's
      // ancestry (single-seed window), then focus it like any in-view hit.
      setError(null);
      try {
        const data = await jumpToCommit(repoId, id);
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        setExpandedDead(new Set());
        setUserCollapsed(new Set());
        setViewMode('all');
        setViewResetKey(k => k + 1);
        focusSeqRef.current += 1;
        setFocusTarget({ id, seq: focusSeqRef.current });
        handleCommitClick(id);
      } catch (err) {
        recordFrontendError(errText(err));
        setError(errText(err));
      }
      return;
    }
    // In-view hit: expand its lane if collapsed (compressed or inactive),
    // then center on it.
    const c = gitData?.commits.find(x => x.id === id);
    if (c && inactive?.dead.has(c.lane_owner)) {
      setExpandedDead(prev => new Set(prev).add(c.lane_owner));
    }
    focusSeqRef.current += 1;
    setFocusTarget({ id, seq: focusSeqRef.current });
    handleCommitClick(id);
  }, [handleCommitClick, gitData, inactive, repoId, loadDiffStats]);

  // Header branch-name click: re-anchor on HEAD. The "where am I" button
  // for a 6000-commit map -- same machinery as the locate hit (expand a
  // collapsed head lane, center on the node, select it).
  const jumpToHead = useCallback(() => {
    const head = gitData?.commits.find(c => c.is_head);
    if (!head) return;
    if (inactive?.dead.has(head.lane_owner)) {
      setExpandedDead(prev => new Set(prev).add(head.lane_owner));
    }
    focusSeqRef.current += 1;
    setFocusTarget({ id: head.id, seq: focusSeqRef.current });
    handleCommitClick(head.id);
  }, [gitData, inactive, handleCommitClick]);

  // Manager row: [★][dot][name][solo]. The WHOLE row is the include/exclude
  // hit target (the loaded-set toggle, the panel's advanced verb), the star
  // is the persisted favorite, solo replaces the whole loaded set with this
  // one lane. Right-click copies the name -- the same desktop convention as
  // everywhere else. No drag, no FLIP: the row never moves on toggle, so
  // the eye re-orientes by position instead of chasing an animation.
  const renderMgrRow = (branch: BranchLane) => {
    const on = selectedBranches.includes(branch.name);
    const starred = pinnedBranches.includes(branch.name);
    return (
      <div
        key={branch.name}
        className={`mgr-row${on ? ' sel' : ''}${highlightedRefName === branch.name ? ' hl' : ''}`}
        role="checkbox"
        aria-checked={on}
        title={`${branch.name} · ${t('chipHint')}`}
        onClick={() => toggleInclude([branch.name], !on)}
        onContextMenu={e => {
          e.preventDefault();
          copyName(branch.name);
        }}
      >
        <button
          type="button"
          className={`mgr-row-star${starred ? ' on' : ''}`}
          title={starred ? t('unpin') : t('pin')}
          aria-label={starred ? t('unpin') : t('pin')}
          onClick={e => { e.stopPropagation(); togglePin(branch.name); }}
        >
          {starred ? '★' : '☆'}
        </button>
        <span className="branch-row-dot" style={{ background: branch.color }} />
        {branch.is_tag && (
          <svg className="branch-row-tag-ico" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
            <circle cx="5.3" cy="5.3" r="0.8" fill="currentColor" stroke="none" />
          </svg>
        )}
        <span className="mgr-row-name">{truncateMiddle(branch.name)}</span>
        <button
          type="button"
          className="mgr-row-solo"
          title={t('onlyThis')}
          aria-label={t('onlyThis')}
          onClick={e => { e.stopPropagation(); handleFilterChange([branch.name]); }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="5" />
            <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
    );
  };

  // Dead-lane row: an EYE, not a checkbox — clicking changes VISIBILITY
  // only (the lane stays selected on the backend side), a different verb
  // than the rows above, so it must not wear the same control.
  const renderDeadRow = (branch: BranchLane) => {
    const on = expandedDead.has(branch.name);
    return (
      <div
        key={branch.name}
        className={`branch-row dead${on ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        title={branch.name}
        onClick={() => toggleDeadLane(branch.name)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDeadLane(branch.name);
          }
        }}
      >
        <svg className="branch-row-eye" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
          {!on && <line x1="3" y1="13" x2="13" y2="3" />}
        </svg>
        <span className="branch-row-dot" style={{ background: branch.color }} />
        <span className="branch-row-name">{truncateMiddle(branch.name)}</span>
      </div>
    );
  };

  // Manager search keys, handled in the field (focus never leaves it while
  // navigating): ↑/↓ walk the flat section order (starred first, then
  // branches), Enter toggles the highlighted row's include state -- the
  // list never reorders on toggle, so the highlight stays on the row --
  // and Esc exits in layers: clear the query first, close the panel
  // second.
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (searchQuery) {
        setSearchQuery('');
        setRowHighlight(0);
      } else {
        closePanel();
        filterInputRef.current?.blur();
      }
      return;
    }
    if (mgrRows.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setRowHighlight(i =>
        Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), mgrRows.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = mgrRows[Math.min(rowHighlight, mgrRows.length - 1)];
      if (!row) return;
      toggleInclude([row.name], !selectedBranches.includes(row.name));
    }
  };

  // How many presentation options sit OFF their default. That count --
  // not the five toggles themselves -- is what the collapsed view-options
  // trigger shows at rest, so hiding the wall does not hide the state.
  const customViewCount =
    (compressed ? 0 : 1) +
    (showMergeLinks ? 0 : 1) +
    (showRefLabels ? 0 : 1) +
    (showAnnotations ? 1 : 0) +
    (showPatchLinks ? 1 : 0) +
    (hideRemotes ? 1 : 0);

  return (
    <>
      <header className="header">
        {/* Identity card, stacked (who / where / on disk): the worktree
            member holds line 1 at full size -- and in multi-member
            families it IS the member selector (same low-frequency-popover
            idiom as the view-options trigger: the state stays visible on
            the trigger, the list is one click away). A member is an anchor
            parameter of this one view, not another view -- that is why it
            is a selector and not a tab. The position pill + commit count
            drop to line 2, the filesystem path is line 3. */}
        <div className="header-left">
          {gitData && (
            <>
              {family.length > 1 ? (
                <div className="member-row">
                  {/* The WORD, not an icon: no glyph reliably says
                      "worktree" to a git user, and a bare name + caret
                      read as a static title. A visible label (form
                      field convention: label + control) tells the user
                      what this selector switches before anything is
                      clicked. */}
                  <span className="member-menu-label">{t('worktrees')}</span>
                  <div className="member-menu-anchor">
                    <button
                      className="member-menu-btn"
                      aria-expanded={memberMenuOpen}
                      aria-haspopup="menu"
                      title={t('switchWorktree')}
                      onClick={() => setMemberMenuOpen(v => !v)}
                    >
                      <span className="member-menu-name">{path.split('/').pop()}</span>
                      {/* Chevron = "a list drops from here" (picker
                          convention); rotates while open. */}
                      <svg className={`member-caret${memberMenuOpen ? ' open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                  {memberMenuOpen && (
                    <>
                      <div className="member-menu-backdrop" onClick={() => setMemberMenuOpen(false)} />
                      <div className="member-menu">
                        <div className="member-menu-title">{t('worktrees')}</div>
                        {family.map(m => {
                          const current = m.path === path;
                          const tip = [
                            m.is_main ? t('mainWorktree') : t('linkedWorktree'),
                            ...(m.head_branch ? [`${t('currentBranchTip')}: ${m.head_branch}`] : []),
                            m.path,
                          ].join('\n');
                          return (
                            <button
                              key={m.path}
                              className={`member-item${current ? ' current' : ''}`}
                              title={tip}
                              onClick={() => {
                                setMemberMenuOpen(false);
                                if (!current) onSwitchMember(m.path);
                              }}
                            >
                              <span className="member-item-name">
                                {m.is_main && (
                                  <svg className="member-item-home" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M2.5 8 8 2.8 13.5 8" />
                                    <path d="M4.2 6.8V13.2h7.6V6.8" />
                                  </svg>
                                )}
                                {m.name}
                              </span>
                              <span className="member-item-branch">{m.head_branch ?? '—'}</span>
                              <span className="member-item-path">{m.path}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  </div>
                </div>
              ) : (
                <h1 className="repo-name" title={path}>{path.split('/').pop()}</h1>
              )}
              <span className="repo-info">
                {/* Position, not classification: head_branch is where THIS
                    member is checked out (a worktree tab must not announce
                    the trunk), main_branch is only the detached-HEAD
                    fallback. Rendered as a pill so it reads as one unit
                    under the repo name, its green dot matching the HEAD ring
                    on the graph and the minimap dot -- same green = same
                    "you are here" meaning on every surface. Clicking jumps
                    back to HEAD -- the anchor to find when lost in a
                    6000-commit map. */}
                <button
                  className="head-chip"
                  title={t('jumpToHead')}
                  onClick={jumpToHead}
                  onMouseEnter={() => setHeadLaneHover(gitData.head_branch)}
                  onMouseLeave={() => setHeadLaneHover(null)}
                >
                  <span className="head-chip-dot" aria-hidden="true" />
                  {gitData.head_branch ?? gitData.main_branch}
                </button>
                {/* The count describes the branch named in the pill: its
                    FULL history (rev-list --count HEAD), not the loaded
                    window, so it stays exact and stable while chunks page
                    in and regardless of the date scope. Hidden on an
                    unborn HEAD (empty repo) where no history exists. */}
                {gitData.head_commit_count != null && (
                  <span className="repo-info-count" title={t('branchCountTip')}>
                    {t('commitCount', { n: gitData.head_commit_count })}
                  </span>
                )}
                {/* Worktree cleanliness at a glance: green dot = clean, amber
                    + count = uncommitted changes, red = merge in progress. */}
                {wtStatus && (() => {
                  const dirty = wtStatus.modified + wtStatus.untracked;
                  const cls = wtStatus.merge_in_progress ? 'wt-merge' : dirty > 0 ? 'wt-dirty' : 'wt-clean';
                  const tip = wtStatus.merge_in_progress ? t('wtMergeTip')
                    : dirty > 0 ? t('wtDirtyTip', { modified: wtStatus.modified, untracked: wtStatus.untracked })
                      : t('wtCleanTip');
                  return (
                    <span className={`wt-status ${cls}`} title={tip}>
                      {wtStatus.merge_in_progress ? '!' : dirty > 0 ? dirty : ''}
                    </span>
                  );
                })()}
              </span>
              <span className="repo-path" title={path}>{path}</span>
            </>
          )}
        </div>

        {branchList.length > 0 && (
          <div className="header-chips">
            {/* Date scope HEADS the data-slice cluster: one stable,
                self-contained axis ("when") anchored before the lane
                presets, so the preset row can grow after it without the
                date control ever moving -- and so the whole lane
                subsystem (presets -> filter field -> status pill) stays
                contiguous to its right, uninterrupted. Changes what data
                is LOADED, unlike the view actions further right; state
                stays visible at rest because a silently active date
                filter would shrink the map with no visible cause. */}
            <div className="header-scope">
              <select
                className="view-btn date-select"
                value={dateRangeValue}
                onChange={e => {
                  const v = e.target.value;
                  // Switching to Custom keeps whatever dates the inputs
                  // hold (empty strings take the fallbacks in customRange).
                  if (v === 'custom') setDateRange(customRange(customFrom, customTo));
                  else if (v === 'all') setDateRange({ kind: 'all' });
                  else setDateRange({ kind: 'preset', days: Number(v) });
                  // Re-cropping re-anchors the canvas: reset the viewport.
                  setViewResetKey(k => k + 1);
                }}
              >
                <option value="all">{t('dateAll')}</option>
                <option value="7">{t('dateWeek')}</option>
                <option value="30">{t('dateMonth')}</option>
                <option value="90">{t('date3m')}</option>
                <option value="365">{t('dateYear')}</option>
                <option value="custom">{t('dateCustom')}</option>
              </select>
              {dateRange.kind === 'custom' && (
                <>
                  <input
                    type="date"
                    className="view-btn date-input"
                    value={customFrom}
                    max={customTo || undefined}
                    title={t('dateFrom')}
                    aria-label={t('dateFrom')}
                    onChange={e => {
                      const v = e.target.value;
                      setCustomFrom(v);
                      setDateRange(customRange(v, customTo));
                      setViewResetKey(k => k + 1);
                    }}
                  />
                  <input
                    type="date"
                    className="view-btn date-input"
                    value={customTo}
                    min={customFrom || undefined}
                    title={t('dateTo')}
                    aria-label={t('dateTo')}
                    onChange={e => {
                      const v = e.target.value;
                      setCustomTo(v);
                      setDateRange(customRange(customFrom, v));
                      setViewResetKey(k => k + 1);
                    }}
                  />
                </>
              )}
            </div>
            {/* View-mode trio (the map model's header controls): narrowing
                here is DISPLAY-level -- stars and activity decide what
                folds, switching is instant, and the lit state is the mode
                itself so it can never silently unlight (the old lens
                presets did). "全部" is the one heavy verb: it also restores
                the full LOADED set. A connected segmented control, not
                three independent pills: the shared border makes the
                three-way exclusivity readable (the user report), so a lit
                segment no longer toggles off -- 全部 is the explicit way
                back. The star dots drop to a SECOND ROW directly under the
                ★ segment. */}
            <div className="lens-block">
              <div className="lens-seg" role="group" aria-label={t('modeGroup')}>
                <button
                  type="button"
                  className={`lens-seg-btn${viewMode === 'active' ? ' on' : ''}`}
                  onClick={() => setViewMode('active')}
                  title={t('modeActiveTip', { n: ACTIVE_MODE_SIZE })}
                >
                  {t('modeActive')}
                </button>
                <button
                  type="button"
                  className={`lens-seg-btn${viewMode === 'starred' ? ' on' : ''}`}
                  onClick={() => setViewMode('starred')}
                  disabled={pinnedBranches.length === 0}
                  title={t('modeStarredTip')}
                >
                  {t('modeStarred')}
                </button>
                <button
                  type="button"
                  className={`lens-seg-btn${viewMode === 'all' ? ' on' : ''}`}
                  onClick={resetLanes}
                  title={t('modeAllTip')}
                >
                  {t('modeAll')}
                </button>
              </div>
              {/* Starred quick bar: one colored dot per favorite (lane colors,
                  so it doubles as a legend), click = the starred view. It
                  belongs to the ★ mode, so it hangs UNDER the ★ segment;
                  inline between the pills it broke the three-way group
                  apart (the user report). Over STAR_DOT_MAX the rest
                  collapse into +N, which opens the manager where every
                  star is listed. */}
              {starDots.length > 0 && (
                <div className="star-dots" role="group" aria-label={t('modeStarredTip')}>
                  {starDots.map(b => (
                    <button
                      key={b.name}
                      type="button"
                      className="star-dot"
                      style={{ background: b.color }}
                      title={t('starDotTip', { name: b.name })}
                      aria-label={t('starDotTip', { name: b.name })}
                      onClick={() => setViewMode('starred')}
                    />
                  ))}
                  {starredOverflow > 0 && (
                    <button
                      type="button"
                      className="star-dot more"
                      title={t('starMoreTip', { n: starredOverflow })}
                      onClick={() => setShowAllTags(true)}
                    >
                      +{starredOverflow}
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Lane manager trigger: a BUTTON, not a text field -- the old
                field-as-trigger made focus imply typing. The label carries
                the honest lane count, N/M while the loaded set is narrowed
                (it absorbed the old filter-status pill; "全部" above is the
                one-click way back). Opens the manager panel, whose own
                search field takes the query. */}
            <button
              type="button"
              className={`lanes-trigger${showAllTags ? ' open' : ''}`}
              onClick={() => setShowAllTags(v => {
                const next = !v;
                // The moment the user looks at the list is the moment
                // freshness matters (the member-menu re-enumeration
                // precedent): OPENING the manager reconciles against the
                // live repo, so a branch deleted outside gtv -- locally,
                // or on the remote ahead of the next fetch -- drops out of
                // the list AND its zombie star dies on the spot instead of
                // waiting for the next poll/fetch cycle (the deleted
                // branch still sitting in ★收藏 report).
                if (next) void refreshHandlerRef.current();
                return next;
              })}
              title={t('lanesTriggerTip')}
              aria-expanded={showAllTags}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="14" y2="12" />
                <circle cx="10" cy="4" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="5" cy="8" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              {selectedActiveCount < activeBranches.length
                ? `${selectedActiveCount}/${activeBranches.length}`
                : `${activeBranches.length}`}
              {t('lanesTrigger')}
            </button>
          </div>
        )}

        {/* Right controls are purely "how it is drawn / navigated": the
            orientation pair (fit, terminal), then the five low-frequency
            presentation toggles collapsed behind one trigger. The data
            scopes (lanes, time) live with the lens group to the left. */}
        <div className="header-right">
          {gitData && (
            <>
              <button
                className="view-btn fetch-btn"
                onClick={handleFetch}
                disabled={fetching}
                title={t('fetchTip')}
              >
                <svg className={fetching ? 'fetch-spin' : undefined} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
                {fetching ? t('fetching') : t('fetch')}
              </button>
              <button
                className="view-btn"
                onClick={() => setFitSignal(n => n + 1)}
                title={t('fitTip')}
              >
                {t('fit')}
              </button>
              <button
                className="view-btn"
                onClick={() => setHeadSignal(n => n + 1)}
                title={t('headHomeTip')}
              >
                ⌖ {t('headHome')}
              </button>
              {(isVsCodeHost || termAvailable) && (
                <button
                  className={`view-btn terminal-toggle-btn${!isVsCodeHost && termOpen ? ' active' : ''}`}
                  onClick={() => {
                    if (isVsCodeHost) {
                      openHostTerminal(path).catch(err => recordFrontendError(errText(err)));
                    } else {
                      setTermOpen(v => !v);
                    }
                  }}
                  title={isVsCodeHost ? t('terminalHostTip') : t('terminalTip')}
                  aria-label={t('terminal')}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                    <polyline points="4.5,6 7,8.5 4.5,11" />
                    <line x1="9" y1="11" x2="11.5" y2="11" />
                  </svg>
                </button>
              )}
              <div className="view-menu-anchor">
                <button
                  className={`view-btn view-menu-btn${viewMenuOpen ? ' active' : ''}`}
                  onClick={() => setViewMenuOpen(v => !v)}
                  title={t('viewOptions')}
                  aria-expanded={viewMenuOpen}
                >
                  {t('viewOptions')}
                  {customViewCount > 0 && (
                    <span className="view-menu-badge">{customViewCount}</span>
                  )}
                </button>
                {viewMenuOpen && (
                  <>
                    {/* Transparent click-catcher: closes on outside click
                        without dimming the graph behind a small menu. */}
                    <div className="view-menu-backdrop" onClick={() => setViewMenuOpen(false)} />
                    <div className="view-menu">
                      <div className="view-menu-title">{t('viewOptions')}</div>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={compressed}
                          onChange={() => setCompressed(v => !v)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('compress')}</span>
                          <span className="view-menu-desc">{t('compressTip')}</span>
                        </span>
                      </label>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={showMergeLinks}
                          onChange={() => setShowMergeLinks(v => !v)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('mergeLinks')}</span>
                          <span className="view-menu-desc">{t('mergeLinksTip')}</span>
                        </span>
                      </label>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={showRefLabels}
                          onChange={() => setShowRefLabels(v => !v)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('labels')}</span>
                          <span className="view-menu-desc">{t('labelsTip')}</span>
                        </span>
                      </label>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={showAnnotations}
                          onChange={() => setShowAnnotations(v => !v)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('annotations')}</span>
                          <span className="view-menu-desc">{t('annotationsTip')}</span>
                        </span>
                      </label>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={showPatchLinks}
                          onChange={() => setShowPatchLinks(v => !v)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('copies')}</span>
                          <span className="view-menu-desc">
                            {patchLinksLoading ? t('copiesLoading') : t('copiesTip')}
                          </span>
                        </span>
                      </label>
                      <label className="view-menu-item">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          checked={!hideRemotes}
                          onChange={e => setHideRemotes(!e.target.checked)}
                        />
                        <span className="view-menu-text">
                          <span className="view-menu-label">{t('remotes')}</span>
                          <span className="view-menu-desc">{t('remotesTip')}</span>
                        </span>
                      </label>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {showAllTags && (
          <>
            {/* Backdrop = transparent viewport-wide click-catcher (same
                idiom as .view-menu-backdrop), SIBLING of the panel: the
                panel's absolute position must anchor to the HEADER
                (position: relative) -- nested inside the fixed backdrop it
                would anchor to the viewport instead, and the header's
                height varies with the identity card. */}
            <div className="branch-panel-backdrop" onClick={closePanel} />
            <div className="branch-panel">
              {/* Head = the search field (moved in from the header: the
                  trigger is a BUTTON now, the query lives where the results
                  are) + class scope + dismiss. The Tags chip (pressed = tag
                  rows listed) is the one scope control the panel needs --
                  version tags can flood the list, branches cannot. */}
              <div className="branch-panel-head">
                <input
                  ref={filterInputRef}
                  type="text"
                  className="panel-search"
                  placeholder={t('filterShort')}
                  title={t('filterTip')}
                  aria-label={t('filterRefs')}
                  value={searchQuery}
                  onChange={e => {
                    setSearchQuery(e.target.value);
                    setRowHighlight(0);
                  }}
                  onKeyDown={onFilterKeyDown}
                />
                <button
                  className={`panel-pill${showTags ? ' on' : ''}`}
                  onClick={toggleShowTags}
                  title={t('tagsTip')}
                  aria-pressed={showTags}
                >
                  {t('tags')}
                </button>
                <button
                  className="branch-panel-close"
                  onClick={closePanel}
                  aria-label={t('close')}
                  title={t('close')}
                >
                  ×
                </button>
              </div>
              <div className="branch-panel-list">
                {/* The single list: ★ starred first (the favorites, whatever
                    their state), then alive branches. Rows do not move on
                    toggle -- include/exclude only flips the row's state, so
                    the eye stays put (the old transfer zones are gone). */}
                {mgrStarredRows.length > 0 && (
                  <div className="branch-panel-group">
                    <div className="branch-panel-group-title">★ {t('sectionStarred', { n: mgrStarredRows.length })}</div>
                    <div className="branch-panel-rows">
                      {mgrStarredRows.map(renderMgrRow)}
                    </div>
                  </div>
                )}
                {mgrBranchRows.length > 0 && (
                  <div className="branch-panel-group">
                    <div className="branch-panel-group-title">{t('sectionBranches', { n: mgrBranchRows.length })}</div>
                    <div className="branch-panel-rows">
                      {mgrBranchRows.map(renderMgrRow)}
                    </div>
                  </div>
                )}
                {DEAD_KINDS.map(kind => {
                  const rows = deadSectionRows(kind);
                  if (rows.length === 0) return null;
                  const label = kind === 'hidden' ? 'hiddenLanes'
                    : kind === 'archived' ? 'archivedLanes' : 'dormantLanes';
                  return (
                    <div className="branch-panel-group" key={kind}>
                      <div className="branch-panel-group-title">
                        {t(label, { n: rows.length })}
                        <button className="view-btn dead-group-btn" onClick={() => expandTraceGroup(kind)}>
                          {traceGroupLabel(kind)}
                        </button>
                      </div>
                      <div className="branch-panel-rows">
                        {rows.map(renderDeadRow)}
                      </div>
                    </div>
                  );
                })}
                {mgrRows.length === 0 && mergedGroups.hidden.length === 0 && mergedGroups.archived.length === 0 && mergedGroups.dormant.length === 0 && (
                  <div className="branch-panel-empty">{t('noRefsMatch')}</div>
                )}
              </div>
              <div className="branch-panel-footer">
                {viewMode !== 'all' && <>{t('modeDiag', { n: excludedCount })} · </>}
                {t('lanesOnCanvas', { n: selectedActiveCount })} · {t('panelFooter')}
              </div>
            </div>
          </>
        )}
      </header>

      {error && (
        <div className="error">
          <span className="error-msg">{error}</span>
          <button
            className="error-report-btn"
            onClick={() => setShowIssueReport(true)}
          >
            {t('reportIssue')}
          </button>
        </div>
      )}

      {/* Checkout success hint: same banner slot as the error strip (green
          variant), auto-dismissed by the timer effect above. */}
      {switchedBranch && (
        <div className="error success">
          <span className="error-msg">{t('switchedTo', { branch: switchedBranch })}</span>
        </div>
      )}

      {/* Copy confirmation: bottom-center, pointer-transparent, gone in
          1.6 s -- it confirms the gesture, it does not narrate. */}
      {copyToast && (
        <div className="copy-toast">
          {copyToast.ok ? t('copied', { name: copyToast.name }) : t('copyRefFailed')}
        </div>
      )}

      {/* Fetch result: same bottom-center shape; failures carry git's
          one-line summary and linger 5 s, the clean confirmation 1.6 s. */}
      {fetchToast && (
        <div className={`copy-toast${fetchToast.ok ? '' : ' error'}`}>
          {fetchToast.text}
        </div>
      )}

      {/* --details-w feeds the narrow panel's width (drag-resizable divider
          below); .wide ignores it. */}
      <main className="main" style={{ '--details-w': `${detailsWidth}px` } as CSSProperties}>
        {/* gitData is seeded from initialData, so this null branch is a
            defensive loading/error shape only -- the no-tabs welcome state
            lives in App (Task 5: "no tab" is shell-level, not view-level). */}
        {!gitData ? null : (
          <>
            {/* Wide split view (DiffSplitView) takes over the main area:
                the timeline hides via display:none -- unmounting would
                throw away its zoom/selection state, exactly like the
                terminal panel's keep-alive rule. */}
            <div style={{ display: detailsWide && (comparePair?.target || selectedCommit) ? 'none' : 'contents' }}>
            <Timeline
              data={view?.data ?? gitData}
              viewKey={path}
              onCommitClick={handleNodeClick}
              selectedCommitId={selectedCommit?.id ?? null}
              resetKey={viewResetKey}
              active={active}
              onViewFromBranch={handleViewFromBranch}
              onRelatedBranch={handleRelatedBranch}
              compressed={compressed}
              showMergeLinks={showMergeLinks}
              showRefLabels={showRefLabels}
              showAnnotations={showAnnotations}
              patchLinks={showPatchLinks ? patchLinks : NO_LINKS}
              fitSignal={fitSignal}
              headSignal={headSignal}
              hasMore={gitData.has_more ?? false}
              loadingOlder={loadingOlder}
              // User-initiated rebuilds only: a background watcher refresh
              // must keep the canvas on screen (the delay-gated scrim read
              // as "the graph disappeared" every time an auto-fetch landed).
              busy={filterBusy}
              onLoadOlder={handleLoadOlder}
              focusCommit={focusTarget}
              hiddenIds={hiddenIds}
              traceRows={view?.traceRows ?? []}
              traceBars={view?.traceBars ?? []}
              onExpandTraceGroup={expandTraceGroup}
              traceGroupLabel={traceGroupLabel}
              headBranch={gitData?.head_branch ?? null}
              headLaneHover={headLaneHover}
              memberLanes={memberLanes}
              onCheckoutBranch={handleCheckoutBranch}
              onCompareClick={handleCompareClick}
              compareBaseId={compareBaseId}
              onComparePair={handleComparePair}
              onCopyName={copyName}
              onCanvasClick={handleCanvasClick}
              starredLanes={starredSet}
              onToggleStarLane={togglePin}
              onFoldLane={foldLane}
            />
            </div>
            {locateOpen && (
              <div className="locate-float">
                <input
                  ref={locateInputRef}
                  type="text"
                  className="search-input locate-input"
                  placeholder={t('locatePlaceholder')}
                  value={locateQuery}
                  onChange={(e) => { setLocateQuery(e.target.value); setLocateIndex(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setLocateIndex(i => Math.min(i + 1, locateResults.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setLocateIndex(i => Math.max(i - 1, 0));
                    } else if (e.key === 'Enter') {
                      const r = locateResults[locateIndex] ?? locateResults[0];
                      if (r) handleLocate(r);
                    } else if (e.key === 'Escape') {
                      // During IME composition Esc cancels the pinyin — the
                      // box must survive that (the window handler guards the
                      // same case for every other focus position).
                      if (!e.nativeEvent.isComposing) setLocateOpen(false);
                    }
                  }}
                />
                {locateQuery.trim() && (
                  <div className="locate-dropdown">
                    {locateResults.length === 0 && (
                      <div className="locate-empty">{t('locateNoResults')}</div>
                    )}
                    {locateResults.map((r, i) => (
                      <button
                        key={r.kind === 'branch' ? `b:${r.name}` : `c:${r.id}`}
                        className={`locate-item ${i === locateIndex ? 'active' : ''}`}
                        // Single click / hover = preview only (the highlighted
                        // row drives the detail panel; dropdown stays open).
                        // Double click (or Enter) = locate in the graph.
                        onMouseDown={(e) => { e.preventDefault(); setLocateIndex(i); }}
                        onDoubleClick={() => handleLocate(r)}
                        onMouseEnter={() => setLocateIndex(i)}
                      >
                        {r.kind === 'branch' ? (
                          <>
                            <span className="locate-branch-dot" style={{ backgroundColor: r.color }} />
                            <span className="locate-name">{r.name}</span>
                          </>
                        ) : (
                          <>
                            <span className="locate-hash">{r.id.slice(0, 7)}</span>
                            <span className="locate-msg">{r.message}</span>
                            <span className="locate-author">{r.author}</span>
                          </>
                        )}
                      </button>
                    ))}
                    {remotePending ? (
                      <div className="locate-footer">{t('locateSearching')}</div>
                    ) : remoteHits.length >= SEARCH_LIMIT ? (
                      <div className="locate-footer">{t('locateHitsCapped', { n: SEARCH_LIMIT })}</div>
                    ) : (
                      <div className="locate-footer">{t('locateHint')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Drag handle for the narrow panel's width (both panel kinds
                share the slot and the width). Rendered only while the slot
                is occupied and narrow -- the wide split view owns the whole
                main area. Pointer capture keeps the gesture glued to the
                handle even when the cursor races off it. */}
            {(selectedCommit || (comparePair && comparePair.target !== '')) && !detailsWide && (
              <div
                className="panel-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={onResizerPointerDown}
                onPointerMove={onResizerPointerMove}
                onPointerUp={onResizerPointerUp}
                onPointerCancel={onResizerPointerUp}
              />
            )}
            {/* Panel slot is EXCLUSIVE (spec 4.4): a complete pair renders
                CompareDetails instead of CommitDetails; a plain node click
                clears the pair (handleNodeClick) and restores the single
                view. Arrow-key stepping only moves selectedCommit, so the
                pair survives underneath -- by design. */}
            {comparePair && comparePair.target !== '' ? (
              <CompareDetails repoId={repoId} pair={comparePair} onClose={handleCloseCompare} onWideChange={setDetailsWide} />
            ) : (
              <CommitDetails
                repoId={repoId}
                commit={selectedCommit}
                onClose={handleCloseDetails}
                onWideChange={setDetailsWide}
              />
            )}
          </>
        )}
      </main>

      {/* Always mounted: hiding the panel keeps the PTY session (and its
          scrollback) alive, VSCode-style. */}
      <TerminalPanel
        repoId={repoId}
        open={termOpen}
        onClose={() => setTermOpen(false)}
        onUnavailable={handleTermUnavailable}
      />

      {checkoutDialog && (
        <CheckoutDialog
          branch={checkoutDialog.branch}
          status={checkoutDialog.status}
          onConfirm={() => doCheckout(checkoutDialog.branch)}
          onClose={() => setCheckoutDialog(null)}
        />
      )}

      {/* Rendered on the ACTIVE tab only (T4 review Low-3): showIssueReport
          is global while the context is per-repo -- with N kept-alive tabs
          the dialog must stay unique, so the active tab owns it. The error
          banners above render per tab (a hidden tab's strip is hidden with
          it, under display:none). */}
      {showIssueReport && active && (
        <IssueReportDialog
          currentError={error}
          repoName={path.split('/').pop() ?? null}
          repoPath={path}
          commitCount={gitData?.commits.length ?? null}
          onClose={() => setShowIssueReport(false)}
        />
      )}
    </>
  );
}
