import { useCallback, useEffect, useState } from 'react';
import type { CompareDetail } from '../types';
import type { ComparePair } from '../compare';
import { getCompareDetail, getPairFileDiff } from '../api';
import { useSettings } from '../settings';
import { recordFrontendError } from '../issueContext';
import { DiffSplitView } from './DiffSplitView';
import { FileChangeList } from './FileChangeList';

// Two-commit compare panel (M3.2, spec 4.5). Self-fetching: handed a
// COMPLETE pair by App, it loads its own CompareDetail on mount and on
// every pair change. File diffs open in the shared full-width split view
// (DiffSplitView); the narrow sidebar keeps only the side summaries and
// the file list. Rides the panel slot App reserves for it -- mutually
// exclusive with CommitDetails (spec 4.4 panel-competition rule).

interface CompareDetailsProps {
  /** Which open repository the compare queries route to (Task 5). */
  repoId: number;
  pair: ComparePair;
  onClose: () => void;
  /** Wide split-view toggle is owned here but RepoView hides the timeline
   *  behind it -- the parent needs to know. */
  onWideChange: (wide: boolean) => void;
}

export function CompareDetails({ repoId, pair, onClose, onWideChange }: CompareDetailsProps) {
  const { t } = useSettings();
  const [detail, setDetail] = useState<CompareDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [widePath, setWidePath] = useState<string | null>(null);

  const pairKey = `${pair.base}:${pair.target}`;

  // Fetch on mount and on every pair change (key = base+target). The
  // cancelled flag drops stale detail responses, and the wide-view state
  // resets with the fetch: a file selected under the old pair means
  // nothing under the new one.
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setWide(false);
    setWidePath(null);
    onWideChange(false);
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
  }, [repoId, pair.base, pair.target]); // eslint-disable-line react-hooks/exhaustive-deps

  const openWide = useCallback((path: string | null) => {
    setWidePath(path);
    setWide(true);
    onWideChange(true);
  }, [onWideChange]);
  const closeWide = useCallback(() => {
    setWide(false);
    onWideChange(false);
  }, [onWideChange]);

  const loadDiff = useCallback(
    (path: string) => getPairFileDiff(repoId, pair.base, pair.target, path),
    [repoId, pair.base, pair.target],
  );

  const summary = detail ? (
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
    </>
  ) : null;

  if (wide && detail) {
    return (
      <DiffSplitView
        title={`${t('compareBase')} → ${t('compareTarget')}`}
        summary={summary}
        files={detail.files}
        totalAdditions={detail.total_additions}
        totalDeletions={detail.total_deletions}
        cacheKey={pairKey}
        loadDiff={loadDiff}
        onCollapse={closeWide}
        onClose={onClose}
        initialPath={widePath}
      />
    );
  }

  return (
    <div className="commit-details">
      <div className="commit-details-header">
        <h3>{t('compareBase')} → {t('compareTarget')}</h3>
        <div className="header-actions">
          {detail && detail.files.length > 0 && (
            <button
              className="close-btn"
              title={t('expandViewTip')}
              aria-label={t('expandViewTip')}
              onClick={() => openWide(null)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="commit-details-content">
        {error ? (
          <div className="file-diff file-diff-error">{error}</div>
        ) : !detail ? (
          <div className="file-diff file-diff-loading">{t('loading')}</div>
        ) : (
          <>
            {summary}

            {detail.files.length > 0 && (
              /* Pure renames arrive as D + A rows (Task 2 review
                  Minor-1: this path runs without find_similar) --
                  shown as-is; the frontend does not paper over known
                  backend semantics. File rows open the full-width
                  split view with that file selected. */
              <FileChangeList
                files={detail.files}
                totalAdditions={detail.total_additions}
                totalDeletions={detail.total_deletions}
                onSelect={openWide}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
