import { useMemo, useState } from 'react';
import type { FileChange } from '../types';
import { useSettings } from '../settings';
import { buildFileTree, type FileTreeNode } from '../filetree';

// Changed-files list with a flat / tree layout toggle, shared by the wide
// DiffSplitView (left column) and the narrow CommitDetails/CompareDetails
// sidebars. The toggle persists in localStorage like the other view
// preferences (gtv_* keys); directory collapse state is per-component and
// deliberately NOT persisted (it means nothing across commits).

const MODE_KEY = 'gtv_file_mode';
type Mode = 'flat' | 'tree';

interface FileChangeListProps {
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  /** Highlighted file (split view's current selection); null in the
   *  narrow sidebars where a row is just an "open" affordance. */
  selectedPath?: string | null;
  onSelect: (path: string) => void;
}

export function FileChangeList({ files, totalAdditions, totalDeletions, selectedPath, onSelect }: FileChangeListProps) {
  const { t } = useSettings();
  const [mode, setModeState] = useState<Mode>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem(MODE_KEY) === 'tree') ? 'tree' : 'flat');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const tree = useMemo(() => (mode === 'tree' ? buildFileTree(files) : null), [mode, files]);

  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* best-effort */ }
  };
  const toggleDir = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const fileRow = (file: FileChange, depth = 0) => (
    <div
      key={file.path}
      className={`file-row clickable ${selectedPath === file.path ? 'expanded' : ''}`}
      style={depth > 0 ? { paddingLeft: depth * 14 + 4 } : undefined}
      onClick={() => onSelect(file.path)}
    >
      <span className={`status ${file.status.toLowerCase()}`}>{file.status}</span>
      <span className="path">{depth > 0 ? file.path.split('/').pop() : file.path}</span>
      <span className="diff-add">+{file.additions}</span>
      <span className="diff-del">−{file.deletions}</span>
    </div>
  );

  const dirNode = (node: FileTreeNode & { kind: 'dir' }, depth: number): React.ReactNode => {
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        <div
          className="file-row clickable dir-row"
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => toggleDir(node.path)}
        >
          <span className="dir-caret">{isCollapsed ? '▸' : '▾'}</span>
          <span className="dir-name">{node.name}</span>
        </div>
        {!isCollapsed && node.children.map(child =>
          child.kind === 'dir' ? dirNode(child, depth + 1) : fileRow(child.file, depth + 1))}
      </div>
    );
  };

  return (
    <div className="files-section">
      <h4>
        {t('changedFiles', { n: files.length })}
        <span className="diff-total">
          {' '}<span className="diff-add">+{totalAdditions}</span>
          {' '}<span className="diff-del">−{totalDeletions}</span>
        </span>
        <span className="file-mode-toggle" role="group" aria-label={t('fileModeToggle')}>
          <button
            className={mode === 'flat' ? 'active' : ''}
            title={t('fileModeFlat')}
            aria-label={t('fileModeFlat')}
            onClick={() => setMode('flat')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <button
            className={mode === 'tree' ? 'active' : ''}
            title={t('fileModeTree')}
            aria-label={t('fileModeTree')}
            onClick={() => setMode('tree')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4h6l2 3h10v13H3z" />
              <path d="M3 4v16" />
            </svg>
          </button>
        </span>
      </h4>
      <div className="files-list">
        {mode === 'flat'
          ? files.map(file => fileRow(file))
          : tree!.map(node => node.kind === 'dir' ? dirNode(node, 0) : fileRow(node.file))}
      </div>
    </div>
  );
}
