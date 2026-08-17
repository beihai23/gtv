import type { CommitDetail } from '../types';

interface CommitDetailsProps {
  commit: CommitDetail | null;
  onClose: () => void;
}

export function CommitDetails({ commit, onClose }: CommitDetailsProps) {
  if (!commit) return null;

  const date = new Date(commit.timestamp * 1000);
  const timeAgo = getTimeAgo(commit.timestamp);

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
            <h4>Changed Files ({commit.files.length})</h4>
            <div className="files-list">
              {commit.files.map((file, i) => (
                <div key={i} className="file-row">
                  <span className={`status ${file.status.toLowerCase()}`}>{file.status}</span>
                  <span className="path">{file.path}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
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
