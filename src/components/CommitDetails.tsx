import { useEffect, useState } from 'react';
import type { CommitDetail } from '../types';
import { getFileDiff } from '../api';

interface CommitDetailsProps {
  commit: CommitDetail | null;
  onClose: () => void;
}

interface FileDiffState {
  text: string;
  isError?: boolean;
}

export function CommitDetails({ commit, onClose }: CommitDetailsProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const commitId = commit?.id ?? null;
  useEffect(() => {
    setExpandedPath(null);
    setDiffs({});
    setLoadingPath(null);
  }, [commitId]);

  if (!commit) return null;

  const date = new Date(commit.timestamp * 1000);
  const timeAgo = getTimeAgo(commit.timestamp);

  const toggleFile = async (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    if (diffs[path]) return;

    setLoadingPath(path);
    try {
      const text = await getFileDiff(commit.id, path);
      setDiffs(prev => ({ ...prev, [path]: { text } }));
    } catch (e) {
      setDiffs(prev => ({ ...prev, [path]: { text: String(e), isError: true } }));
    } finally {
      setLoadingPath(prev => (prev === path ? null : prev));
    }
  };

  return (
    <div className="commit-details">
      <div className="commit-details-header">
        <h3>Commit Details</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="commit-details-content">
        <div className="detail-row">
          <span className="label">Hash:</span>
          <code className="value">{commit.id}</code>
        </div>

        <div className="detail-row">
          <span className="label">Author:</span>
          <span className="value">{commit.author_name}</span>
        </div>

        <div className="detail-row">
          <span className="label">Email:</span>
          <span className="value">{commit.author_email}</span>
        </div>

        <div className="detail-row">
          <span className="label">Date:</span>
          <span className="value">{date.toLocaleString()} ({timeAgo})</span>
        </div>

        {commit.branch_refs.length > 0 && (
          <div className="detail-row">
            <span className="label">Branches:</span>
            <div className="tags">
              {commit.branch_refs.map((ref, i) => (
                <span key={i} className={`tag ${ref.is_tag ? 'tag-tag' : 'tag-branch'}`}>
                  {ref.name}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="detail-row">
          <span className="label">Message:</span>
          <div className="message">{commit.full_message}</div>
        </div>

        {commit.files.length > 0 && (
          <div className="files-section">
            <h4>
              Changed Files ({commit.files.length})
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
                      <div className="file-diff file-diff-loading">Loading diff…</div>
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

function DiffView({ text }: { text: string }) {
  return (
    <div className="file-diff">
      {text.split('\n').map((line, i) => {
        let cls = 'diff-line';
        if (line.startsWith('@@')) cls += ' diff-line-hunk';
        else if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-line-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-line-del';
        return (
          <div key={i} className={cls}>{line || ' '}</div>
        );
      })}
    </div>
  );
}

function getTimeAgo(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return `${Math.floor(diff)} seconds ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)} months ago`;
  return `${Math.floor(diff / 31536000)} years ago`;
}
