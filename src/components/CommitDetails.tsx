import { useEffect, useRef, useState } from 'react';
import type { CommitDetail } from '../types';
import { getFileDiff } from '../api';
import { useSettings } from '../settings';
import { filterRefs } from '../refs';
import { DiffView, type FileDiffState } from './DiffView';

interface CommitDetailsProps {
  commit: CommitDetail | null;
  onClose: () => void;
}

export function CommitDetails({ commit, onClose }: CommitDetailsProps) {
  const { t, hideRemotes } = useSettings();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const commitId = commit?.id ?? null;
  // Stale-response guard (pre-existing race, same shape as CompareDetails'
  // pairRef): toggleFile's in-flight patch can resolve after the commit
  // prop changed -- the effect below clears the diffs cache, but a late
  // resolve would re-seed the NEW commit's cache with the OLD commit's
  // patch. The ref is how a late resolve notices the commit moved on.
  const commitIdRef = useRef(commitId);
  useEffect(() => {
    commitIdRef.current = commitId;
    setExpandedPath(null);
    setDiffs({});
    setLoadingPath(null);
  }, [commitId]);

  if (!commit) return null;

  // Chips share the badge/tooltip filter (spec 4.3): the panel derives from
  // the FILTERED refs; the whole row hides when nothing survives.
  const shownRefs = filterRefs(commit.branch_refs, hideRemotes);

  const date = new Date(commit.timestamp * 1000);
  const timeAgo = getTimeAgo(commit.timestamp, t);

  const toggleFile = async (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    if (diffs[path]) return;

    // Call-time snapshot; the ref check after the await drops responses
    // that no longer belong to the commit the panel is showing.
    const id = commit.id;
    setLoadingPath(path);
    try {
      const text = await getFileDiff(id, path);
      if (commitIdRef.current !== id) return;
      setDiffs(prev => ({ ...prev, [path]: { text } }));
    } catch (e) {
      if (commitIdRef.current !== id) return;
      setDiffs(prev => ({ ...prev, [path]: { text: String(e), isError: true } }));
    } finally {
      setLoadingPath(prev => (prev === path ? null : prev));
    }
  };

  return (
    <div className="commit-details">
      <div className="commit-details-header">
        <h3>{t('details')}</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="commit-details-content">
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

        {commit.files.length > 0 && (
          <div className="files-section">
            <h4>
              {t('changedFiles', { n: commit.files.length })}
              <span className="diff-total">
                {' '}<span className="diff-add">+{commit.total_additions}</span>
                {' '}<span className="diff-del">−{commit.total_deletions}</span>
              </span>
            </h4>
            <div className="files-list">
              {commit.files.map((file, i) => (
                <div key={i} className="file-entry">
                  <div
                    className={`file-row clickable ${expandedPath === file.path ? 'expanded' : ''}`}
                    onClick={() => toggleFile(file.path)}
                  >
                    <span className={`status ${file.status.toLowerCase()}`}>{file.status}</span>
                    <span className="path">{file.path}</span>
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
