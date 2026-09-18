import { useEffect, useRef, useState } from 'react';
import type { CompareDetail } from '../types';
import type { ComparePair } from '../compare';
import { getCompareDetail, getPairFileDiff } from '../api';
import { useSettings } from '../settings';
import { recordFrontendError } from '../issueContext';
import { DiffView, type FileDiffState } from './DiffView';

// Two-commit compare panel (M3.2, spec 4.5). Self-fetching: handed a
// COMPLETE pair by App, it loads its own CompareDetail on mount and on
// every pair change, then lazily loads per-file patches exactly the way
// CommitDetails does (toggleFile pattern + the shared DiffView renderer).
// Rides the panel slot App reserves for it -- mutually exclusive with
// CommitDetails (spec 4.4 panel-competition rule).

interface CompareDetailsProps {
  /** Which open repository the compare queries route to (Task 5). */
  repoId: number;
  pair: ComparePair;
  onClose: () => void;
}

export function CompareDetails({ repoId, pair, onClose }: CompareDetailsProps) {
  const { t } = useSettings();
  const [detail, setDetail] = useState<CompareDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  // Stale-response guard for the lazy diff: toggleFile snapshots the pair
  // at call time, but its getPairFileDiff can resolve AFTER the pair
  // changed -- the effect below clears the diffs cache, yet a late resolve
  // would re-seed the NEW pair's cache with the OLD pair's patch (and the
  // `diffs[path]` early return would then serve it). The ref is how a late
  // resolve notices the pair moved on. Same shape as CommitDetails'
  // commitIdRef guard.
  const pairRef = useRef(pair);

  // Fetch on mount and on every pair change (key = base+target). The
  // cancelled flag drops stale detail responses, and the lazy-diff state
  // resets with the fetch; together with the pairRef guard above, an old
  // file's patch never shows (nor lingers in the cache) under a new pair.
  useEffect(() => {
    let cancelled = false;
    pairRef.current = pair;
    setDetail(null);
    setError(null);
    setExpandedPath(null);
    setDiffs({});
    setLoadingPath(null);
    getCompareDetail(repoId, pair.base, pair.target)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(e => {
        if (cancelled) return;
        // Parity with the single-details path (RepoView handleCommitClick):
        // the panel shows the error AND it enters the issue-report ring.
        recordFrontendError(String(e));
        setError(String(e));
      });
    return () => { cancelled = true; };
  }, [repoId, pair.base, pair.target]);

  const toggleFile = async (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    if (diffs[path]) return;

    // Call-time snapshot; the ref check after the await drops responses
    // that no longer belong to the pair the panel is showing.
    const { base, target } = pair;
    setLoadingPath(path);
    try {
      const text = await getPairFileDiff(repoId, base, target, path);
      if (pairRef.current.base !== base || pairRef.current.target !== target) return;
      setDiffs(prev => ({ ...prev, [path]: { text } }));
    } catch (e) {
      if (pairRef.current.base !== base || pairRef.current.target !== target) return;
      setDiffs(prev => ({ ...prev, [path]: { text: String(e), isError: true } }));
    } finally {
      setLoadingPath(prev => (prev === path ? null : prev));
    }
  };

  return (
    <div className="commit-details">
      <div className="commit-details-header">
        <h3>{t('compareBase')} → {t('compareTarget')}</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="commit-details-content">
        {error ? (
          <div className="file-diff file-diff-error">{error}</div>
        ) : !detail ? (
          <div className="file-diff file-diff-loading">{t('loading')}</div>
        ) : (
          <>
            <div className="detail-row">
              <span className="label">{t('compareBase')}</span>
              <div className="compare-side">
                <code className="value">{detail.base.short_id}</code>
                <span>{detail.base.subject}</span>
                <span>{detail.base.author}</span>
              </div>
            </div>

            <div className="detail-row">
              <span className="label">{t('compareTarget')}</span>
              <div className="compare-side">
                <code className="value">{detail.target.short_id}</code>
                <span>{detail.target.subject}</span>
                <span>{detail.target.author}</span>
              </div>
            </div>

            {detail.files.length > 0 && (
              <div className="files-section">
                <h4>
                  {t('changedFiles', { n: detail.files.length })}
                  <span className="diff-total">
                    {' '}<span className="diff-add">+{detail.total_additions}</span>
                    {' '}<span className="diff-del">−{detail.total_deletions}</span>
                  </span>
                </h4>
                <div className="files-list">
                  {/* Pure renames arrive as D + A rows (Task 2 review
                      Minor-1: this path runs without find_similar) --
                      shown as-is; the frontend does not paper over known
                      backend semantics. Real additions/deletions come
                      straight from the backend (not the hardcoded zeros
                      of the parent-vs-commit channel). */}
                  {detail.files.map((file, i) => (
                    <div key={i} className="file-entry">
                      <div
                        className={`file-row clickable ${expandedPath === file.path ? 'expanded' : ''}`}
                        onClick={() => toggleFile(file.path)}
                      >
                        <span className={`status ${file.status.toLowerCase()}`}>{file.status}</span>
                        <span className="path">{file.path}</span>
                        {/* Per-file +/− (spec 4.5) -- real backend numbers,
                            unlike the parent-vs-commit channel's zeros; same
                            diff-add/diff-del convention as the totals row. */}
                        <span className="diff-add">+{file.additions}</span>
                        <span className="diff-del">−{file.deletions}</span>
                        <span className="expand-hint">{expandedPath === file.path ? '▾' : '▸'}</span>
                      </div>
                      {expandedPath === file.path && (
                        loadingPath === file.path ? (
                          <div className="file-diff file-diff-loading">{t('loadingDiff')}</div>
                        ) : diffs[file.path] ? (
                          diffs[file.path].isError ? (
                            <div className="file-diff file-diff-error">{diffs[file.path].text}</div>
                          ) : (
                            <DiffView text={diffs[file.path].text} />
                          )
                        ) : null
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
