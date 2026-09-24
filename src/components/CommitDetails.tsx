import { useCallback, useEffect, useState } from 'react';
import type { CommitDetail } from '../types';
import { getFileDiff } from '../api';
import { useSettings } from '../settings';
import { filterRefs } from '../refs';
import { DiffSplitView } from './DiffSplitView';
import { FileChangeList } from './FileChangeList';

interface CommitDetailsProps {
  /** Which open repository the diff queries route to (Task 5). */
  repoId: number;
  commit: CommitDetail | null;
  onClose: () => void;
  /** Wide split-view toggle is owned here but RepoView hides the timeline
   *  behind it -- the parent needs to know. */
  onWideChange: (wide: boolean) => void;
}

export function CommitDetails({ repoId, commit, onClose, onWideChange }: CommitDetailsProps) {
  const { t, hideRemotes } = useSettings();
  const [wide, setWide] = useState(false);
  const [widePath, setWidePath] = useState<string | null>(null);

  const commitId = commit?.id ?? null;
  // A commit switch (arrow-key stepping, refresh) collapses the wide view
  // back to the narrow summary: the split's patch cache keys on the commit
  // id, but the user's place in the old commit's file list is meaningless
  // under the new one.
  useEffect(() => {
    setWide(false);
    setWidePath(null);
    onWideChange(false);
  }, [commitId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    (path: string) => getFileDiff(repoId, commitId!, path),
    [repoId, commitId],
  );

  if (!commit) return null;

  // Chips share the badge/tooltip filter (spec 4.3): the panel derives from
  // the FILTERED refs; the whole row hides when nothing survives.
  const shownRefs = filterRefs(commit.branch_refs, hideRemotes);

  const date = new Date(commit.timestamp * 1000);
  const timeAgo = getTimeAgo(commit.timestamp, t);

  const summary = (
    <>
      <div className="detail-row">
        <span className="label">{t('hash')}</span>
        <code className="value">{commit.id}</code>
      </div>
      <div className="detail-row">
        <span className="label">{t('author')}</span>
        <span className="value">{commit.author_name}</span>
      </div>
      <div className="detail-row">
        <span className="label">{t('email')}</span>
        <span className="value">{commit.author_email}</span>
      </div>
      <div className="detail-row">
        <span className="label">{t('date')}</span>
        <span className="value">{date.toLocaleString()} ({timeAgo})</span>
      </div>
      {shownRefs.length > 0 && (
        <div className="detail-row">
          <span className="label">{t('branches')}</span>
          <div className="tags">
            {shownRefs.map((ref, i) => (
              <span key={i} className={`tag ${ref.is_tag ? 'tag-tag' : 'tag-branch'}`}>
                {ref.name}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="detail-row">
        <span className="label">{t('message')}</span>
        <div className="message">{commit.full_message}</div>
      </div>
    </>
  );

  if (wide) {
    return (
      <DiffSplitView
        title={t('details')}
        summary={summary}
        files={commit.files}
        totalAdditions={commit.total_additions}
        totalDeletions={commit.total_deletions}
        cacheKey={commit.id}
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
        <h3>{t('details')}</h3>
        <div className="header-actions">
          {commit.files.length > 0 && (
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
        {summary}

        {commit.files.length > 0 && (
          /* File rows open the full-width split view with that file
             selected -- the 360px sidebar keeps the summary, diffs are
             read against the whole main area, never inline. */
          <FileChangeList
            files={commit.files}
            totalAdditions={commit.total_additions}
            totalDeletions={commit.total_deletions}
            onSelect={openWide}
          />
        )}
      </div>
    </div>
  );
}

function getTimeAgo(timestamp: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return t('agoSeconds', { n: Math.floor(diff) });
  if (diff < 3600) return t('agoMinutes', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('agoHours', { n: Math.floor(diff / 3600) });
  if (diff < 2592000) return t('agoDays', { n: Math.floor(diff / 86400) });
  if (diff < 31536000) return t('agoMonths', { n: Math.floor(diff / 2592000) });
  return t('agoYears', { n: Math.floor(diff / 31536000) });
}
