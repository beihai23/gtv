import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import './App.css';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { CompareDetails } from './components/CompareDetails';
import { SettingsDialog } from './components/SettingsDialog';
import { IssueReportDialog } from './components/IssueReportDialog';
import { CheckoutDialog } from './components/CheckoutDialog';
import TerminalPanel from './components/TerminalPanel';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from './settings';
import { selectAndOpenRepository, openRepository, getCommitDetail, getBranchList, filterByBranches, getCurrentPath, switchBranch, getPatchLinks, getCommitStats, loadOlderCommits, searchCommits, jumpToCommit, getWorktreeStatus, checkoutBranch } from './api';
import { recordFrontendError } from './issueContext';
import { computeInactive, collapseLanes } from './inactive';
import type { DeadKind } from './inactive';
import { applyDateRange, emptyLaneDead, outOfRangeIds } from './daterange';
import type { DateRange } from './daterange';
import { saveSelection, loadSelection, restoreSelection } from './persist';
import { relatedLanes } from './related';
import { matchLoaded, mergeLocate, SEARCH_LIMIT } from './locate';
import type { LocateResult } from './locate';
import { nextPair } from './compare';
import type { ComparePair } from './compare';
import type { GitData, CommitDetail, BranchLane, PatchLink, WorktreeStatus } from './types';
import type { SearchHit } from './types';

const LATEST_REPO_KEY = 'gtv_latest_repo';
const SHOW_TAGS_KEY = 'gtv_show_tags';

// Stable empty-set fallback so the Timeline props keep one identity when no
// view is computed (avoids per-render Set churn re-triggering its effects).
const NO_IDS: Set<string> = new Set();

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

function App() {
  const { t, showStaleBranches, inactiveDays, hideRemotes, setHideRemotes } = useSettings();
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchList, setBranchList] = useState<BranchLane[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showIssueReport, setShowIssueReport] = useState(false);
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
  // Integrated terminal (bottom panel). `termOpen` is deliberately not
  // persisted: auto-restoring it would silently spawn a login shell on
  // every launch — a terminal should be an explicit user action.
  const [termOpen, setTermOpen] = useState(false);
  const [termAvailable, setTermAvailable] = useState(true);

  // Cmd/Ctrl + , toggles the settings dialog (macOS convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(s => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl+` toggles the bottom terminal — works with focus anywhere,
  // including inside the xterm textarea (whose keydown we do NOT bail on
  // like the arrow-keys handler below; xterm's custom handler steps aside
  // for this combo and the event still bubbles here). Ctrl only: Cmd+` is
  // the macOS cycle-windows shortcut and must stay free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && gitData) {
        e.preventDefault();
        setTermOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gitData]);
  // Version-tag flood control: hides tag chips from the toolbar and panel.
  const [showTags, setShowTags] = useState(() => localStorage.getItem(SHOW_TAGS_KEY) !== '0');
  const toggleShowTags = useCallback(() => {
    setShowTags(v => {
      localStorage.setItem(SHOW_TAGS_KEY, v ? '0' : '1');
      return !v;
    });
  }, []);
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
  // View options live here so the header owns the whole toolbar row.
  const [compressed, setCompressed] = useState(true);
  const [showMergeLinks, setShowMergeLinks] = useState(true);
  const [showRefLabels, setShowRefLabels] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  // Date-range window (M2.2): pure display state, session-only -- never
  // persisted, and both repo-open handlers reset it to 'all' so a fresh
  // repo never inherits the previous one's window. The Custom inputs keep
  // their own 'YYYY-MM-DD' strings so switching presets and back never
  // loses what the user typed.
  const [dateRange, setDateRange] = useState<DateRange>({ kind: 'all' });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Cherry-pick / rebase copy detection (expensive: one diff per commit),
  // computed on demand when the toggle is switched on.
  const [showPatchLinks, setShowPatchLinks] = useState(false);
  const [patchLinks, setPatchLinks] = useState<PatchLink[]>([]);
  const [patchLinksLoading, setPatchLinksLoading] = useState(false);

  // Inactive-lane collapse: which dead lanes the user has restored.
  const [expandedDead, setExpandedDead] = useState<Set<string>>(new Set());

  const [latestRepo, setLatestRepo] = useState<string | null>(null);

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
    () => (dateRange.kind !== 'all' && rangedData ? emptyLaneDead(rangedData, expandedDead) : null),
    [dateRange.kind, rangedData, expandedDead],
  );
  const inactive = useMemo(
    () => (rangedData ? computeInactive(rangedData, inactiveDays, expandedDead) : null),
    [rangedData, inactiveDays, expandedDead],
  );
  const dead = useMemo(() => {
    const m = new Map(inactive?.dead ?? []);
    for (const [k, v] of rangeEmpty?.dead ?? []) m.set(k, v);
    return m;
  }, [inactive, rangeEmpty]);
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
  const mergedGroups = useMemo(() => {
    const merge = (kind: 'archived' | 'dormant'): BranchLane[] => {
      const seen = new Set<string>();
      const out: BranchLane[] = [];
      for (const l of [...(inactive?.groups[kind] ?? []), ...(rangeEmpty?.groups[kind] ?? [])]) {
        if (seen.has(l.name)) continue;
        seen.add(l.name); out.push(l);
      }
      return out;
    };
    return { archived: merge('archived'), dormant: merge('dormant') };
  }, [inactive, rangeEmpty]);
  const allDeadNames = useMemo(() => {
    const s = new Set<string>();
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
    getPatchLinks()
      .then(links => { if (!cancelled) setPatchLinks(links ?? []); })
      .catch(() => { if (!cancelled) setPatchLinks([]); })
      .finally(() => { if (!cancelled) setPatchLinksLoading(false); });
    return () => { cancelled = true; };
  }, [showPatchLinks, gitData]);

  useEffect(() => {
    const saved = localStorage.getItem(LATEST_REPO_KEY);
    if (saved) {
      setLatestRepo(saved);
    }
  }, []);

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
    getCommitStats(ids)
      .then(stats => {
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
  }, []);

  // Rebuild the backend view for a branch subset. Declared ABOVE the
  // repo-open handlers: they call it for the M2.4 selection restore, and a
  // useCallback dep array is read during render, so a later declaration
  // would be a TDZ error (the M1.3 landmine).
  const handleFilterChange = useCallback(async (branchNames: string[]) => {
    setSelectedBranches(branchNames);
    setLoading(true);
    try {
      const data = await filterByBranches(branchNames);
      setGitData(data);
      loadDiffStats(data);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpenRepo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await selectAndOpenRepository(showStaleBranches);
      if (data) {
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        // Repo switch: nothing of the OLD repo's panel state may leak
        // into the new session. comparePair is the real fix (Task 5 --
        // no backdrop guards it; stale oids would be fed to the NEW
        // repo's compare calls); the checkout confirm/banner resets are
        // defensive one-liners (Task 4 review Low-1: the z-80 backdrop
        // makes them unreachable today, but the cost is one line each).
        setComparePair(null);
        setCheckoutDialog(null);
        setSwitchedBranch(null);
        setExpandedDead(new Set());
        setViewResetKey(k => k + 1);
        // A freshly opened repo never inherits the previous one's window
        // (nor its typed Custom date strings).
        setDateRange({ kind: 'all' });
        setCustomFrom('');
        setCustomTo('');

        const path = await getCurrentPath();
        if (path) {
          localStorage.setItem(LATEST_REPO_KEY, path);
          setLatestRepo(path);
          // The OLD repo's selection must never be written under the NEW
          // repo's key: setLatestRepo lands before the await below, and the
          // save effect would fire with (newPath, oldSelection) across the
          // batching boundary.
          setSelectedBranches([]);
        }

        const branches = await getBranchList();
        setBranchList(branches);
        setSelectedBranches(branches.map(b => b.name));
        // M2.4: restore this repo's persisted focus set. handleFilterChange
        // itself sets selectedBranches, so no duplicate set here; null ->
        // keep the default full selection (no rebuild, no second flash).
        if (path) {
          const restored = restoreSelection(loadSelection(path), branches.map(b => b.name));
          if (restored) handleFilterChange(restored);
        }
        setSearchQuery('');
        setLocateQuery('');
        setLocateOpen(false);
      }
    } catch (err) {
      console.error('Error:', err);
      recordFrontendError(errText(err));
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [showStaleBranches, handleFilterChange]);

  const handleOpenLatestRepo = useCallback(async () => {
    if (!latestRepo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await openRepository(latestRepo, showStaleBranches);
      setGitData(data);
      loadDiffStats(data);
      setSelectedCommit(null);
      // Same old-repo panel-state reset as the picker path above.
      setComparePair(null);
      setCheckoutDialog(null);
      setSwitchedBranch(null);
      setExpandedDead(new Set());
      setViewResetKey(k => k + 1);
      // Same session-window reset as the picker path above.
      setDateRange({ kind: 'all' });
      setCustomFrom('');
      setCustomTo('');

      const branches = await getBranchList();
      setBranchList(branches);
      setSelectedBranches(branches.map(b => b.name));
      // M2.4: restore the persisted focus set for this repo path. null ->
      // keep the default full selection; handleFilterChange sets
      // selectedBranches itself.
      const restored = restoreSelection(loadSelection(latestRepo), branches.map(b => b.name));
      if (restored) handleFilterChange(restored);
      setSearchQuery('');
      setLocateQuery('');
      setLocateOpen(false);
    } catch (err) {
      console.error('Error:', err);
      recordFrontendError(errText(err));
      setError(errText(err));
      localStorage.removeItem(LATEST_REPO_KEY);
      setLatestRepo(null);
    } finally {
      setLoading(false);
    }
  }, [latestRepo, showStaleBranches, handleFilterChange]);

  // Changing the stale-branches setting re-opens the current repo so the
  // backend session is rebuilt with the new policy.
  const staleSettingRef = useRef(showStaleBranches);
  useEffect(() => {
    if (staleSettingRef.current === showStaleBranches) return;
    staleSettingRef.current = showStaleBranches;
    if (latestRepo) handleOpenLatestRepo();
  }, [showStaleBranches, latestRepo, handleOpenLatestRepo]);

  // Background refresh when the repo changed outside gtv (terminal git
  // commands, editor, another tool — the watcher.rs poller emits
  // "repo-changed"). Unlike handleOpenLatestRepo this must not yank the
  // user's context: keep the selection when its commit survived, keep the
  // viewport (no viewResetKey bump), keep expanded lanes and filters.
  // Loaded-older pagination state is rebuilt from scratch — accepted v1
  // limitation. Rebased/amended commits get new oids, so stale selections
  // drop naturally.
  const refreshingRef = useRef(false);
  const handleRepoRefresh = useCallback(async () => {
    if (!latestRepo || refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const keepId = selectedCommit?.id ?? null;
      const data = await openRepository(latestRepo, showStaleBranches);
      setGitData(data);
      loadDiffStats(data);
      if (keepId && data.commits.some(c => c.id === keepId)) {
        try {
          setSelectedCommit(await getCommitDetail(keepId));
        } catch {
          setSelectedCommit(null);
        }
      } else {
        setSelectedCommit(null);
      }
      const branches = await getBranchList();
      setBranchList(branches);
      setSelectedBranches(prev => {
        const names = new Set(branches.map(b => b.name));
        const kept = prev.filter(n => names.has(n));
        return kept.length ? kept : branches.map(b => b.name);
      });
    } catch (err) {
      // A transient failure (e.g. racing a repo being replaced) must not
      // nuke the view; the next change event retries.
      recordFrontendError(errText(err));
    } finally {
      refreshingRef.current = false;
    }
  }, [latestRepo, showStaleBranches, selectedCommit, loadDiffStats]);

  // Debounce "repo-changed" bursts (rebase/fetch fire several) into one
  // refresh. The handler lives in a ref so resubscription only happens
  // when the repo itself changes, not on every selection.
  const refreshHandlerRef = useRef(handleRepoRefresh);
  useEffect(() => {
    refreshHandlerRef.current = handleRepoRefresh;
  }, [handleRepoRefresh]);
  const repoRefreshTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!latestRepo) return;
    let dead = false;
    let un: (() => void) | null = null;
    try {
      listen('repo-changed', () => {
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
  }, [latestRepo]);

  // Page in the next chunk of older history. The backend re-lays out the
  // whole loaded set; Timeline keeps the viewport anchored (no resetKey bump).
  const [loadingOlder, setLoadingOlder] = useState(false);
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !gitData?.has_more) return;
    setLoadingOlder(true);
    try {
      const data = await loadOlderCommits();
      if (!data) return;
      setGitData(data);
      loadDiffStats(data);
      // Paging may have reached a previously stale branch tip: new lanes
      // mean the chip list needs a refresh (lane colors come from the view).
      if (data.branches.length !== gitData.branches.length) {
        const branches = await getBranchList();
        setBranchList(branches);
      }
    } catch (err) {
      recordFrontendError(errText(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, gitData, loadDiffStats]);

  const handleCommitClick = useCallback(async (commitId: string) => {
    try {
      const detail = await getCommitDetail(commitId);
      setSelectedCommit(detail);
    } catch (err) {
      console.error('Failed to get commit detail:', err);
      recordFrontendError(errText(err));
    }
  }, []);

  const handleCloseDetails = useCallback(() => {
    setSelectedCommit(null);
  }, []);

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
  }, []);

  // Half-pair marker for the canvas: the pending base is ringed only
  // while the pair is incomplete -- a complete pair opens the panel.
  const compareBaseId = comparePair && comparePair.target === '' ? comparePair.base : null;

  // M2.1 lane-menu action: rebuild the view with only the target lane's
  // blood-line closure. The closure is computed from the RAW gitData -- the
  // display copy (view) collapses lanes and rewrites lane_index, while the
  // walk needs the full window structure; names are stable either way.
  const handleRelatedBranch = useCallback((name: string) => {
    if (!gitData) return;
    handleFilterChange([...relatedLanes(gitData, name)]);
  }, [gitData, handleFilterChange]);

  const handleViewFromBranch = useCallback(async (branchName: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await switchBranch(branchName);
      setGitData(data);
      loadDiffStats(data);
      setSelectedCommit(null);
      // The viewed branch is the user's focus: it starts expanded.
      setExpandedDead(new Set([branchName]));
      setViewResetKey(k => k + 1);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // M3.1 checkout (spec 4.2). After a successful checkout the app does
  // NOTHING else to the view -- no setGitData, no refresh call: the
  // repo-changed watcher (1.5s poll + 500ms debounce -> handleRepoRefresh)
  // is the ONE rebuild path (spec 4.3, arc invariant). Declared above
  // handleCheckoutBranch, which depends on it (the M1.3 TDZ rule).
  const doCheckout = useCallback(async (branch: string) => {
    setError(null);
    try {
      await checkoutBranch(branch);
      setCheckoutDialog(null);
      setSwitchedBranch(branch);
    } catch (err) {
      // Close a pending confirm so the error banner is not dimmed behind
      // the backdrop; the backend text already states the set_head
      // half-success residual state honestly.
      setCheckoutDialog(null);
      recordFrontendError(errText(err));
      setError(errText(err));
    }
  }, []);

  // Lane-menu "check out this branch": preflight the worktree, then either
  // confirm (dirty) or switch right away (clean). Checking out the CURRENT
  // branch goes through unchanged too (git semantics: safe no-op, spec 5).
  const handleCheckoutBranch = useCallback(async (branch: string) => {
    try {
      const status = await getWorktreeStatus();
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

  const toggleBranchFilter = useCallback((branchName: string) => {
    if (selectedBranches.includes(branchName)) {
      const newSelected = selectedBranches.filter(b => b !== branchName);
      setSelectedBranches(newSelected);
      handleFilterChange(newSelected);
    } else {
      const newSelected = [...selectedBranches, branchName];
      setSelectedBranches(newSelected);
      handleFilterChange(newSelected);
    }
  }, [selectedBranches, handleFilterChange]);

  // M2.4 focus-set persistence: mirror every selection change into
  // localStorage under the repo path (click cadence, no debounce needed).
  // An EMPTY selection is transient session state ("None" scratch state
  // mid-curation) and is deliberately never written -- without the guard,
  // that scratch state would overwrite the curated set, and an empty save
  // restores as null (full default), losing it.
  useEffect(() => {
    if (!latestRepo || selectedBranches.length === 0) return;
    saveSelection(latestRepo, selectedBranches);
  }, [latestRepo, selectedBranches]);

  // Dead-lane chips toggle VISIBILITY ONLY: they never go through
  // toggleBranchFilter, so the lane stays inside selectedBranches and every
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
  const expandTraceGroup = useCallback((kind: DeadKind) => {
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
  const traceGroupLabel = useCallback((kind: DeadKind) => {
    const group = mergedGroups[kind];
    const expanded = group.length > 0 && group.every(l => expandedDead.has(l.name));
    return t(expanded ? 'collapseGroup' : 'expandGroup');
  }, [mergedGroups, expandedDead, t]);

  // Latest activity time per ref (branch lane or tag), derived from the
  // loaded commits. Used to order the branch chips newest-first.
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

  const sortedBranches = useMemo(() => {
    return [...branchList].sort((a, b) =>
      (refActivity.get(b.name) ?? 0) - (refActivity.get(a.name) ?? 0));
  }, [branchList, refActivity]);

  const filteredBranches = useMemo(() => {
    const visible = showTags ? sortedBranches : sortedBranches.filter(b => !b.is_tag);
    if (!searchQuery) return visible;
    const query = searchQuery.toLowerCase();
    return visible.filter(b => b.name.toLowerCase().includes(query));
  }, [sortedBranches, searchQuery, showTags]);

  // Active-only ref view: dead lanes never appear as header chips or in the
  // Enabled/Disabled panel groups (they live in the panel's Archived/Dormant
  // groups, which keep their own counts), so every count the header shows —
  // "+N more", "refs shown" — derives from this list, not filteredBranches.
  const activeBranches = useMemo(
    () => filteredBranches.filter(b => !allDeadNames.has(b.name)),
    [filteredBranches, allDeadNames]
  );
  const activeSelectedCount = useMemo(
    () => selectedBranches.filter(name => !allDeadNames.has(name)).length,
    [selectedBranches, allDeadNames]
  );

  const INLINE_CHIP_LIMIT = 8;
  const inlineBranches = useMemo(() => {
    // Selected branches stay visible; fill remaining slots by list order.
    const selected = activeBranches.filter(b => selectedBranches.includes(b.name));
    const rest = activeBranches.filter(b => !selectedBranches.includes(b.name));
    return [...selected, ...rest].slice(0, INLINE_CHIP_LIMIT);
  }, [activeBranches, selectedBranches]);

  const hasMoreTags = activeBranches.length > inlineBranches.length;

  // Panel groups: enabled (selected) chips first, then the rest. Dead lanes
  // are excluded here — they have their own groups below and never leave
  // selectedBranches.
  const panelEnabled = useMemo(
    () => activeBranches.filter(b => selectedBranches.includes(b.name)),
    [activeBranches, selectedBranches]
  );
  const panelDisabled = useMemo(
    () => activeBranches.filter(b => !selectedBranches.includes(b.name)),
    [activeBranches, selectedBranches]
  );

  // Dead-lane panel groups (newest activity first, matching the chips above).
  const byActivity = (a: BranchLane, b: BranchLane) =>
    (refActivity.get(b.name) ?? 0) - (refActivity.get(a.name) ?? 0);
  const panelArchived = useMemo(
    () => [...mergedGroups.archived].sort(byActivity),
    [mergedGroups, refActivity]
  );
  const panelDormant = useMemo(
    () => [...mergedGroups.dormant].sort(byActivity),
    [mergedGroups, refActivity]
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
    const remote = dateRange.kind === 'all'
      ? remoteHits
      : remoteHits.map(h => ({ ...h, in_view: h.in_view && !outOfRange.has(h.id) }));
    return mergeLocate(
      matchLoaded(rangedData?.commits ?? [], rangedData?.branches ?? [], locateQuery, hideRemotes),
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
      getCommitDetail(r.kind === 'branch' ? r.commitId : r.id)
        .then(d => { if (!cancelled) setSelectedCommit(d); })
        .catch(() => {});
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [locateOpen, locateIndex, locateResults]);

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
      searchCommits(q, SEARCH_LIMIT)
        .then(hits => { if (!cancelled) { setRemoteHits(hits ?? []); setRemotePending(false); } })
        .catch(() => { if (!cancelled) { setRemoteHits([]); setRemotePending(false); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [locateQuery, gitData]);

  // Cmd/Ctrl + F toggles the floating search over the graph.
  const locateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        if (!gitData) return;
        e.preventDefault();
        setLocateOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gitData]);
  useEffect(() => {
    if (locateOpen) locateInputRef.current?.focus();
  }, [locateOpen]);

  // ←/→ step to the previous/next commit on the SAME lane while the
  // detail panel is open. commits are in ascending (time, topo) order —
  // i.e. visual left→right — so index ±1 is the visual neighbor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedCommit || !gitData) return;
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
  }, [selectedCommit, gitData, handleCommitClick, hiddenIds, outOfRange]);

  // Esc closes ONLY the compare panel (spec 4.4): selectedCommit is left
  // untouched, and no global Esc-for-single-details behavior is added
  // (none exists today). A half-pair (target '') is not an open panel --
  // Esc leaves it for a plain click or the next ctrl+click to resolve.
  // Inputs keep their own Esc handling (locate dropdown), so typing in
  // one never closes the panel behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !comparePair || comparePair.target === '') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      setComparePair(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [comparePair]);

  const handleLocate = useCallback(async (r: LocateResult) => {
    const id = r.kind === 'branch' ? r.commitId : r.id;
    setLocateQuery('');
    setLocateOpen(false);
    if (r.kind === 'commit' && !r.in_view) {
      // Hit outside the loaded window: swap the view to the target's
      // ancestry (single-seed window), then focus it like any in-view hit.
      setLoading(true);
      setError(null);
      try {
        const data = await jumpToCommit(id);
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        setExpandedDead(new Set());
        setViewResetKey(k => k + 1);
        focusSeqRef.current += 1;
        setFocusTarget({ id, seq: focusSeqRef.current });
        handleCommitClick(id);
      } catch (err) {
        recordFrontendError(errText(err));
        setError(errText(err));
      } finally {
        setLoading(false);
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
  }, [handleCommitClick, gitData, inactive, loadDiffStats]);

  const renderBranchChip = (branch: BranchLane) => (
    <button
      key={branch.name}
      className={`filter-tag ${selectedBranches.includes(branch.name) ? 'active' : ''}`}
      style={{
        borderColor: branch.color,
        backgroundColor: selectedBranches.includes(branch.name) ? branch.color : 'transparent'
      }}
      onClick={() => toggleBranchFilter(branch.name)}
      onDoubleClick={() => handleFilterChange([branch.name])}
      title={`${branch.name}\n${t('chipTip')}`}
    >
      {truncateMiddle(branch.name)}
    </button>
  );

  // Dead-lane chip: active = lane restored on the canvas. Clicking toggles
  // visibility only (the lane stays selected on the backend side).
  const renderDeadChip = (branch: BranchLane) => (
    <button
      key={branch.name}
      className={`filter-tag ${expandedDead.has(branch.name) ? 'active' : ''}`}
      style={{
        borderColor: branch.color,
        backgroundColor: expandedDead.has(branch.name) ? branch.color : 'transparent'
      }}
      onClick={() => toggleDeadLane(branch.name)}
      title={branch.name}
    >
      {truncateMiddle(branch.name)}
    </button>
  );

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          {gitData && latestRepo && (
            <h1 className="repo-name" title={latestRepo}>{latestRepo.split('/').pop()}</h1>
          )}
          {gitData && rangedData && (
            <span className="repo-info">
              {gitData.main_branch} • {t(gitData.has_more ? 'commitCountMore' : 'commitCount', { n: rangedData.commits.length })}
            </span>
          )}
          <button
            className="open-btn"
            onClick={handleOpenRepo}
            disabled={loading}
          >
            {loading ? t('loading') : t('openRepo')}
          </button>
        </div>

        {branchList.length > 0 && (
          <div className="header-chips">
            <div className="filter-tags">
              {inlineBranches.map(renderBranchChip)}
            </div>
            {hasMoreTags && (
              <button
                className="filter-tag show-more"
                onClick={() => setShowAllTags(!showAllTags)}
              >
                {showAllTags ? t('closeUp') : t('more', { n: activeBranches.length - inlineBranches.length })}
              </button>
            )}
          </div>
        )}

        <div className="header-right">
          {gitData && (
            <div className="view-toggles">
              <button
                className={`view-btn ${compressed ? 'active' : ''}`}
                onClick={() => setCompressed(v => !v)}
                title={t('compressTip')}
              >
                {t('compress')}
              </button>
              <button
                className={`view-btn ${showMergeLinks ? 'active' : ''}`}
                onClick={() => setShowMergeLinks(v => !v)}
              >
                {t('mergeLinks')}
              </button>
              <button
                className={`view-btn ${showRefLabels ? 'active' : ''}`}
                onClick={() => setShowRefLabels(v => !v)}
              >
                {t('labels')}
              </button>
              <button
                className={`view-btn ${showPatchLinks ? 'active' : ''}`}
                onClick={() => setShowPatchLinks(v => !v)}
                title={t('copiesTip')}
              >
                {patchLinksLoading ? t('copiesLoading') : t('copies')}
              </button>
              <button
                className="view-btn"
                onClick={() => setFitSignal(n => n + 1)}
                title={t('fitTip')}
              >
                {t('fit')}
              </button>
              <button
                className={`view-btn ${hideRemotes ? 'active' : ''}`}
                onClick={() => setHideRemotes(!hideRemotes)}
                title={t('remotesTip')}
              >
                {t('remotes')}
              </button>
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
          )}
          {gitData && termAvailable && (
            <button
              className={`view-btn terminal-toggle-btn${termOpen ? ' active' : ''}`}
              onClick={() => setTermOpen(v => !v)}
              title={t('terminalTip')}
              aria-label={t('terminal')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <polyline points="4.5,6 7,8.5 4.5,11" />
                <line x1="9" y1="11" x2="11.5" y2="11" />
              </svg>
            </button>
          )}
          <button
            className="view-btn settings-btn"
            onClick={() => setShowSettings(true)}
            title={`${t('settings')} (⌘,)`}
          >
            ⚙
          </button>
        </div>
      </header>

      {showAllTags && (
        <div className="branch-panel-backdrop" onClick={() => setShowAllTags(false)}>
          <div className="branch-panel" onClick={e => e.stopPropagation()}>
            <div className="branch-panel-header">
              <input
                type="text"
                className="search-input branch-panel-search"
                placeholder={t('filterRefs')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <span className="branch-panel-count">{t('refsShown', { n: activeBranches.length, m: activeSelectedCount })}</span>
              <button
                className={`view-btn ${showTags ? 'active' : ''}`}
                onClick={toggleShowTags}
                title={t('tagsTip')}
              >
                {t('tags')}
              </button>
              <button className="view-btn" onClick={() => handleFilterChange(branchList.map(b => b.name))}>{t('all')}</button>
              <button className="view-btn" onClick={() => handleFilterChange([])}>{t('none')}</button>
              <button className="view-btn" onClick={() => setShowAllTags(false)}>{t('close')}</button>
            </div>
            <div className="branch-panel-list">
              {panelEnabled.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">{t('enabled', { n: panelEnabled.length })}</div>
                  <div className="branch-panel-chips">
                    {panelEnabled.map(renderBranchChip)}
                  </div>
                </div>
              )}
              {panelDisabled.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">{t('disabled', { n: panelDisabled.length })}</div>
                  <div className="branch-panel-chips">
                    {panelDisabled.map(renderBranchChip)}
                  </div>
                </div>
              )}
              {panelArchived.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">
                    {t('archivedLanes', { n: panelArchived.length })}
                    <button className="view-btn dead-group-btn" onClick={() => expandTraceGroup('archived')}>
                      {traceGroupLabel('archived')}
                    </button>
                  </div>
                  <div className="branch-panel-chips">
                    {panelArchived.map(renderDeadChip)}
                  </div>
                </div>
              )}
              {panelDormant.length > 0 && (
                <div className="branch-panel-group">
                  <div className="branch-panel-group-title">
                    {t('dormantLanes', { n: panelDormant.length })}
                    <button className="view-btn dead-group-btn" onClick={() => expandTraceGroup('dormant')}>
                      {traceGroupLabel('dormant')}
                    </button>
                  </div>
                  <div className="branch-panel-chips">
                    {panelDormant.map(renderDeadChip)}
                  </div>
                </div>
              )}
            </div>
            <div className="branch-panel-footer">
              {t('panelFooter')}
            </div>
          </div>
        </div>
      )}

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

      <main className="main">
        {!gitData ? (
          <div className="welcome">
            <h2>{t('welcomeTitle')}</h2>
            <p>{t('welcomeSubtitle')}</p>
            <p className="hint">{t('welcomeHint')}</p>
            {latestRepo && (
              <button 
                className="latest-repo-btn" 
                onClick={handleOpenLatestRepo}
                disabled={loading}
              >
                {t('openLatest', { name: latestRepo.split('/').pop() ?? '' })}
              </button>
            )}
          </div>
        ) : (
          <>
            <Timeline
              data={view?.data ?? gitData}
              onCommitClick={handleNodeClick}
              selectedCommitId={selectedCommit?.id ?? null}
              resetKey={viewResetKey}
              onViewFromBranch={handleViewFromBranch}
              onRelatedBranch={handleRelatedBranch}
              compressed={compressed}
              showMergeLinks={showMergeLinks}
              showRefLabels={showRefLabels}
              patchLinks={showPatchLinks ? patchLinks : []}
              fitSignal={fitSignal}
              hasMore={gitData.has_more ?? false}
              loadingOlder={loadingOlder}
              onLoadOlder={handleLoadOlder}
              focusCommit={focusTarget}
              hiddenIds={hiddenIds}
              traceRows={view?.traceRows ?? []}
              traceBars={view?.traceBars ?? []}
              onExpandTraceGroup={expandTraceGroup}
              traceGroupLabel={traceGroupLabel}
              headBranch={gitData?.head_branch ?? null}
              onCheckoutBranch={handleCheckoutBranch}
              onCompareClick={handleCompareClick}
              compareBaseId={compareBaseId}
              onComparePair={handleComparePair}
            />
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
                      setLocateOpen(false);
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
            {/* Panel slot is EXCLUSIVE (spec 4.4): a complete pair renders
                CompareDetails instead of CommitDetails; a plain node click
                clears the pair (handleNodeClick) and restores the single
                view. Arrow-key stepping only moves selectedCommit, so the
                pair survives underneath -- by design. */}
            {comparePair && comparePair.target !== '' ? (
              <CompareDetails pair={comparePair} onClose={handleCloseCompare} />
            ) : (
              <CommitDetails
                commit={selectedCommit}
                onClose={handleCloseDetails}
              />
            )}
          </>
        )}
      </main>

      {/* Always mounted: hiding the panel keeps the PTY session (and its
          scrollback) alive, VSCode-style. */}
      <TerminalPanel
        open={termOpen}
        onClose={() => setTermOpen(false)}
        onUnavailable={() => setTermAvailable(false)}
      />

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {checkoutDialog && (
        <CheckoutDialog
          branch={checkoutDialog.branch}
          status={checkoutDialog.status}
          onConfirm={() => doCheckout(checkoutDialog.branch)}
          onClose={() => setCheckoutDialog(null)}
        />
      )}

      {showIssueReport && (
        <IssueReportDialog
          currentError={error}
          repoName={latestRepo?.split('/').pop() ?? null}
          commitCount={gitData?.commits.length ?? null}
          onClose={() => setShowIssueReport(false)}
        />
      )}
    </div>
  );
}

export default App;
