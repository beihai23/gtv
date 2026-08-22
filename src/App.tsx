import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import './App.css';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { SettingsDialog } from './components/SettingsDialog';
import { IssueReportDialog } from './components/IssueReportDialog';
import { useSettings } from './settings';
import { selectAndOpenRepository, openRepository, getCommitDetail, getBranchList, filterByBranches, getCurrentPath, switchBranch, getPatchLinks, getCommitStats, loadOlderCommits } from './api';
import { recordFrontendError } from './issueContext';
import type { GitData, CommitDetail, BranchLane, PatchLink } from './types';

const LATEST_REPO_KEY = 'gtv_latest_repo';
const SHOW_TAGS_KEY = 'gtv_show_tags';

// Header search (jump to commit hash / branch name) result.
type LocateResult =
  | { kind: 'branch'; name: string; color: string; commitId: string }
  | { kind: 'commit'; id: string; message: string };

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
  const { t, showStaleBranches } = useSettings();
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
  // View options live here so the header owns the whole toolbar row.
  const [compressed, setCompressed] = useState(true);
  const [showMergeLinks, setShowMergeLinks] = useState(true);
  const [showRefLabels, setShowRefLabels] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  // Cherry-pick / rebase copy detection (expensive: one diff per commit),
  // computed on demand when the toggle is switched on.
  const [showPatchLinks, setShowPatchLinks] = useState(false);
  const [patchLinks, setPatchLinks] = useState<PatchLink[]>([]);
  const [patchLinksLoading, setPatchLinksLoading] = useState(false);

  const [latestRepo, setLatestRepo] = useState<string | null>(null);

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

  const handleOpenRepo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await selectAndOpenRepository(showStaleBranches);
      if (data) {
        setGitData(data);
        loadDiffStats(data);
        setSelectedCommit(null);
        setViewResetKey(k => k + 1);
        
        const path = await getCurrentPath();
        if (path) {
          localStorage.setItem(LATEST_REPO_KEY, path);
          setLatestRepo(path);
        }
        
        const branches = await getBranchList();
        setBranchList(branches);
        setSelectedBranches(branches.map(b => b.name));
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
  }, [showStaleBranches]);

  const handleOpenLatestRepo = useCallback(async () => {
    if (!latestRepo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await openRepository(latestRepo, showStaleBranches);
      setGitData(data);
      loadDiffStats(data);
      setSelectedCommit(null);
      setViewResetKey(k => k + 1);
      
      const branches = await getBranchList();
      setBranchList(branches);
      setSelectedBranches(branches.map(b => b.name));
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
  }, [latestRepo, showStaleBranches]);

  // Changing the stale-branches setting re-opens the current repo so the
  // backend session is rebuilt with the new policy.
  const staleSettingRef = useRef(showStaleBranches);
  useEffect(() => {
    if (staleSettingRef.current === showStaleBranches) return;
    staleSettingRef.current = showStaleBranches;
    if (latestRepo) handleOpenLatestRepo();
  }, [showStaleBranches, latestRepo, handleOpenLatestRepo]);

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

  const handleViewFromBranch = useCallback(async (branchName: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await switchBranch(branchName);
      setGitData(data);
      loadDiffStats(data);
      setSelectedCommit(null);
      setViewResetKey(k => k + 1);
    } catch (err) {
      recordFrontendError(errText(err));
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  const INLINE_CHIP_LIMIT = 8;
  const inlineBranches = useMemo(() => {
    // Selected branches stay visible; fill remaining slots by list order.
    const selected = filteredBranches.filter(b => selectedBranches.includes(b.name));
    const rest = filteredBranches.filter(b => !selectedBranches.includes(b.name));
    return [...selected, ...rest].slice(0, INLINE_CHIP_LIMIT);
  }, [filteredBranches, selectedBranches]);

  const hasMoreTags = filteredBranches.length > inlineBranches.length;

  // Panel groups: enabled (selected) chips first, then the rest.
  const panelEnabled = useMemo(
    () => filteredBranches.filter(b => selectedBranches.includes(b.name)),
    [filteredBranches, selectedBranches]
  );
  const panelDisabled = useMemo(
    () => filteredBranches.filter(b => !selectedBranches.includes(b.name)),
    [filteredBranches, selectedBranches]
  );

  // Header search results: branch/ref names (substring) + commit hash
  // (prefix, >=4 hex chars). Only the currently loaded view is searched —
  // the dropdown footer says so when more history exists.
  const locateResults = useMemo((): LocateResult[] => {
    const q = locateQuery.trim().toLowerCase();
    if (!q || !gitData) return [];
    const colorOf = new Map(gitData.branches.map(b => [b.name, b.color]));
    const refTarget = new Map<string, string>(); // ref name -> commit it points at
    const laneTip = new Map<string, { id: string; x: number }>();
    for (const c of gitData.commits) {
      for (const r of c.branch_refs) {
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
    if (/^[0-9a-f]{4,}$/.test(q)) {
      for (const c of gitData.commits) {
        if (c.id.startsWith(q)) {
          out.push({ kind: 'commit', id: c.id, message: c.message.split('\n')[0] });
        }
      }
    }
    return out.slice(0, 12);
  }, [gitData, locateQuery]);

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
      const lane = gitData.commits.filter(c => c.lane_owner === current.lane_owner);
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
  }, [selectedCommit, gitData, handleCommitClick]);

  const handleLocate = useCallback((r: LocateResult) => {
    const id = r.kind === 'branch' ? r.commitId : r.id;
    focusSeqRef.current += 1;
    setFocusTarget({ id, seq: focusSeqRef.current });
    handleCommitClick(id);
    setLocateQuery('');
    setLocateOpen(false);
  }, [handleCommitClick]);

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

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          {gitData && latestRepo && (
            <h1 className="repo-name" title={latestRepo}>{latestRepo.split('/').pop()}</h1>
          )}
          {gitData && (
            <span className="repo-info">
              {gitData.main_branch} • {t(gitData.has_more ? 'commitCountMore' : 'commitCount', { n: gitData.commits.length })}
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
                {showAllTags ? t('closeUp') : t('more', { n: filteredBranches.length - inlineBranches.length })}
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
            </div>
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
              <span className="branch-panel-count">{t('refsShown', { n: filteredBranches.length, m: selectedBranches.length })}</span>
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
              data={gitData}
              onCommitClick={handleCommitClick}
              selectedCommitId={selectedCommit?.id ?? null}
              resetKey={viewResetKey}
              onViewFromBranch={handleViewFromBranch}
              compressed={compressed}
              showMergeLinks={showMergeLinks}
              showRefLabels={showRefLabels}
              patchLinks={showPatchLinks ? patchLinks : []}
              fitSignal={fitSignal}
              hasMore={gitData.has_more ?? false}
              loadingOlder={loadingOlder}
              onLoadOlder={handleLoadOlder}
              focusCommit={focusTarget}
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
                        onMouseDown={(e) => { e.preventDefault(); handleLocate(r); }}
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
                          </>
                        )}
                      </button>
                    ))}
                    {gitData.has_more && (
                      <div className="locate-footer">{t('locateScopeHint')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            <CommitDetails
              commit={selectedCommit}
              onClose={handleCloseDetails}
            />
          </>
        )}
      </main>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

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
