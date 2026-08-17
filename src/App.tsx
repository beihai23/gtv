import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import './App.css';
import { Timeline } from './components/Timeline';
import { CommitDetails } from './components/CommitDetails';
import { selectAndOpenRepository, openRepository, getCommitDetail, getBranchList, filterByBranches, getCurrentPath } from './api';
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
  const containerRef = useRef<HTMLDivElement>(null);

  const [latestRepo, setLatestRepo] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LATEST_REPO_KEY);
    if (saved) {
      setLatestRepo(saved);
    }
  }, []);

  const handleOpenRepo = useCallback(async () => {
    console.log('Opening repository...');
    setLoading(true);
    setError(null);
    try {
      console.log('Calling selectAndOpenRepository...');
      const data = await selectAndOpenRepository();
      console.log('Got data:', data);
      if (data) {
        setGitData(data);
        setSelectedCommit(null);
        
        const path = await getCurrentPath();
        if (path) {
          localStorage.setItem(LATEST_REPO_KEY, path);
          setLatestRepo(path);
        }
        
        console.log('Getting branch list...');
        const branches = await getBranchList();
        console.log('Got branches:', branches.length);
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
    console.log('Opening latest repository:', latestRepo);
    setLoading(true);
    setError(null);
    try {
      const data = await openRepository(latestRepo);
      console.log('Got data:', data);
      setGitData(data);
      setSelectedCommit(null);
      
      console.log('Getting branch list...');
      const branches = await getBranchList();
      console.log('Got branches:', branches.length);
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

  const filteredBranches = useMemo(() => {
    if (!searchQuery) return branchList;
    const query = searchQuery.toLowerCase();
    return branchList.filter(b => b.name.toLowerCase().includes(query));
  }, [branchList, searchQuery]);

  const visibleBranches = useMemo(() => {
    if (showAllTags) return filteredBranches;
    return filteredBranches.slice(0, 30);
  }, [filteredBranches, showAllTags]);

  const hasMoreTags = filteredBranches.length > 30;

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
            <>
              <input
                type="text"
                className="search-input"
                placeholder="Filter branches/tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              
              <div className="filter-tags" ref={containerRef}>
                {visibleBranches.map(branch => (
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
                    {showAllTags ? 'Show Less' : `+${filteredBranches.length - 30} more`}
                  </button>
                )}
              </div>
            </>
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
