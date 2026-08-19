import { useState, useCallback, useMemo, useEffect } from 'react';
import './App.css';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { SettingsDialog } from './components/SettingsDialog';
import { useSettings } from './settings';
import { selectAndOpenRepository, openRepository, getCommitDetail, getBranchList, filterByBranches, getCurrentPath, switchBranch, getPatchLinks } from './api';
import type { GitData, CommitDetail, BranchLane, PatchLink } from './types';

const LATEST_REPO_KEY = 'gtv_latest_repo';
const SHOW_TAGS_KEY = 'gtv_show_tags';

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

function App() {
  const { t } = useSettings();
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchList, setBranchList] = useState<BranchLane[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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

  const handleOpenRepo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await selectAndOpenRepository();
      if (data) {
        setGitData(data);
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
      }
    } catch (err) {
      console.error('Error:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpenLatestRepo = useCallback(async () => {
    if (!latestRepo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await openRepository(latestRepo);
      setGitData(data);
      setSelectedCommit(null);
      setViewResetKey(k => k + 1);
      
      const branches = await getBranchList();
      setBranchList(branches);
      setSelectedBranches(branches.map(b => b.name));
      setSearchQuery('');
    } catch (err) {
      console.error('Error:', err);
      setError(err instanceof Error ? err.message : String(err));
      localStorage.removeItem(LATEST_REPO_KEY);
      setLatestRepo(null);
    } finally {
      setLoading(false);
    }
  }, [latestRepo]);

  const handleCommitClick = useCallback(async (commitId: string) => {
    try {
      const detail = await getCommitDetail(commitId);
      setSelectedCommit(detail);
    } catch (err) {
      console.error('Failed to get commit detail:', err);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setSelectedCommit(null);
      setViewResetKey(k => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
              {gitData.main_branch} • {t('commitCount', { n: gitData.commits.length })}
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
          {error}
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
            />
            <CommitDetails 
              commit={selectedCommit}
              onClose={handleCloseDetails}
            />
          </>
        )}
      </main>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}

export default App;
