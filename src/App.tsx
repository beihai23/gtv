import { useState, useCallback, useMemo, useEffect } from 'react';
import './App.css';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { selectAndOpenRepository, openRepository, getCommitDetail, getBranchList, filterByBranches, getCurrentPath, switchBranch } from './api';
import type { GitData, CommitDetail, BranchLane } from './types';

const LATEST_REPO_KEY = 'gtv_latest_repo';

function App() {
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchList, setBranchList] = useState<BranchLane[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [viewResetKey, setViewResetKey] = useState(0);

  const [latestRepo, setLatestRepo] = useState<string | null>(null);

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
    if (!searchQuery) return sortedBranches;
    const query = searchQuery.toLowerCase();
    return sortedBranches.filter(b => b.name.toLowerCase().includes(query));
  }, [sortedBranches, searchQuery]);

  const INLINE_CHIP_LIMIT = 12;
  const inlineBranches = useMemo(() => {
    // Selected branches stay visible; fill remaining slots by list order.
    const selected = filteredBranches.filter(b => selectedBranches.includes(b.name));
    const rest = filteredBranches.filter(b => !selectedBranches.includes(b.name));
    return [...selected, ...rest].slice(0, INLINE_CHIP_LIMIT);
  }, [filteredBranches, selectedBranches]);

  const hasMoreTags = filteredBranches.length > inlineBranches.length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Git Timeline Viewer</h1>
          {gitData && (
            <span className="repo-info">
              {gitData.main_branch} • {gitData.commits.length} commits
            </span>
          )}
        </div>
        
        <div className="header-controls">
          {branchList.length > 0 && (
            <div className="filter-tags">
                {inlineBranches.map(branch => (
                  <button
                    key={branch.name}
                    className={`filter-tag ${selectedBranches.includes(branch.name) ? 'active' : ''}`}
                    style={{ 
                      borderColor: branch.color,
                      backgroundColor: selectedBranches.includes(branch.name) ? branch.color : 'transparent'
                    }}
                    onClick={() => toggleBranchFilter(branch.name)}
                  >
                    {branch.name}
                  </button>
                ))}
                {hasMoreTags && (
                  <button 
                    className="filter-tag show-more"
                    onClick={() => setShowAllTags(!showAllTags)}
                  >
                    {showAllTags ? 'Close ▴' : `+${filteredBranches.length - inlineBranches.length} more ▾`}
                  </button>
                )}
              </div>
          )}
          
          <button 
            className="open-btn" 
            onClick={handleOpenRepo}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Open Repository'}
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
                placeholder="Filter branches/tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <span className="branch-panel-count">{filteredBranches.length} refs ({selectedBranches.length} shown)</span>
              <button className="view-btn" onClick={() => setShowAllTags(false)}>Close</button>
            </div>
            <div className="branch-panel-list">
              {filteredBranches.map(branch => (
                <button
                  key={branch.name}
                  className={`filter-tag ${selectedBranches.includes(branch.name) ? 'active' : ''}`}
                  style={{
                    borderColor: branch.color,
                    backgroundColor: selectedBranches.includes(branch.name) ? branch.color : 'transparent'
                  }}
                  onClick={() => toggleBranchFilter(branch.name)}
                >
                  {branch.name}
                </button>
              ))}
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
            <h2>Welcome to Git Timeline Viewer</h2>
            <p>Click "Open Repository" to select a Git repository</p>
            <p className="hint">Only reads data - no modifications will be made</p>
            {latestRepo && (
              <button 
                className="latest-repo-btn" 
                onClick={handleOpenLatestRepo}
                disabled={loading}
              >
                Open Latest: {latestRepo.split('/').pop()}
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
            />
            <CommitDetails 
              commit={selectedCommit}
              onClose={handleCloseDetails}
            />
          </>
        )}
      </main>
    </div>
  );
}

export default App;
