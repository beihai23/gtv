import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileChange } from '../types';
import { useSettings } from '../settings';
import { DiffView, type FileDiffState, type DiffMode } from './DiffView';
import { FileChangeList } from './FileChangeList';

// Diff reading preferences, persisted like the other gtv_* view keys.
const NUMS_KEY = 'gtv_diff_nums';
const MODE_KEY = 'gtv_diff_mode';
function readBool(key: string, dflt: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? dflt : v === '1'; } catch { return dflt; }
}
function writePref(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* best-effort */ }
}

// Full-width split view for reading file changes (the wide mode of
// CommitDetails and CompareDetails). The narrow 360px sidebar keeps the
// commit summary; this view takes over the main canvas area: left column
// = summary + file list, right column = the selected file's patch at full
// width. Shared by both panels because their file-list/lazy-diff shape is
// identical -- they differ only in the summary rows and the loadDiff call.

interface DiffSplitViewProps {
  /** Header title (Commit Details / Base → Target). */
  title: string;
  /** Commit-meta rows rendered above the file list in the left column. */
  summary: ReactNode;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  /** Identity of the data being viewed (commit id / base:target). When it
   *  changes the patch cache and the selection reset -- and in-flight
   *  loads for the OLD key are dropped (stale-response guard, same shape
   *  as CommitDetails' commitIdRef). */
  cacheKey: string;
  /** Lazy per-file patch loader; resolves the unified-diff text. */
  loadDiff: (path: string) => Promise<string>;
  /** Collapse back to the narrow panel (Esc does the same). */
  onCollapse: () => void;
  /** Close the whole panel. */
  onClose: () => void;
  /** File to select on open (the row the user clicked); defaults to the
   *  first file. */
  initialPath?: string | null;
}

export function DiffSplitView({ title, summary, files, totalAdditions, totalDeletions, cacheKey, loadDiff, onCollapse, onClose, initialPath }: DiffSplitViewProps) {
  const { t } = useSettings();
  const [selected, setSelected] = useState<string | null>(initialPath ?? files[0]?.path ?? null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});
  const [loading, setLoading] = useState(false);
  const [showNums, setShowNums] = useState(() => readBool(NUMS_KEY, true));
  const [diffMode, setDiffMode] = useState<DiffMode>(() =>
    (readBool(MODE_KEY, false) ? 'split' : 'unified'));
  const toggleNums = () => {
    setShowNums(v => { writePref(NUMS_KEY, v ? '0' : '1'); return !v; });
  };
  const setMode = (m: DiffMode) => {
    setDiffMode(m);
    writePref(MODE_KEY, m === 'split' ? '1' : '0');
  };

  const keyRef = useRef(cacheKey);
  useEffect(() => {
    keyRef.current = cacheKey;
    setDiffs({});
    setSelected(initialPath ?? files[0]?.path ?? null);
    // files/initialPath are derived from cacheKey upstream; re-picking the
    // selection on every files identity change would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Lazy-load the selected file's patch (cached per path per cacheKey).
  useEffect(() => {
    if (!selected || diffs[selected]) return;
    let cancelled = false;
    const key = cacheKey;
    setLoading(true);
    loadDiff(selected)
      .then(text => {
        if (cancelled || keyRef.current !== key) return;
        setDiffs(prev => ({ ...prev, [selected]: { text: String(text ?? '') } }));
      })
      .catch(e => {
        if (cancelled || keyRef.current !== key) return;
        setDiffs(prev => ({ ...prev, [selected]: { text: String(e), isError: true } }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected, cacheKey, loadDiff, diffs]);

  // Esc collapses to the narrow panel (inputs keep their own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      onCollapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCollapse]);

  const cur = selected ? diffs[selected] : undefined;

  return (
    <div className="commit-details wide">
      <div className="commit-details-header">
        <h3>{title}</h3>
        <div className="header-actions">
          <button className="close-btn" title={t('collapseViewTip')} aria-label={t('collapseViewTip')} onClick={onCollapse}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button className="close-btn" title={t('close')} aria-label={t('close')} onClick={onClose}>×</button>
        </div>
      </div>

      <div className="diff-split">
        <div className="diff-split-left">
          {summary}
          {files.length > 0 && (
            <FileChangeList
              files={files}
              totalAdditions={totalAdditions}
              totalDeletions={totalDeletions}
              selectedPath={selected}
              onSelect={setSelected}
            />
          )}
        </div>

        <div className="diff-split-right">
          {!selected ? (
            <div className="diff-split-empty">{t('selectFileHint')}</div>
          ) : (
            <>
              <div className="diff-toolbar">
                <span className="diff-filepath" title={selected}>{selected}</span>
                <span className="diff-toolbar-actions">
                  <button
                    className={showNums ? 'active' : ''}
                    title={t('diffNumsTip')}
                    aria-label={t('diffNumsTip')}
                    onClick={toggleNums}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="4" y1="6" x2="4.01" y2="6" />
                      <line x1="4" y1="12" x2="4.01" y2="12" />
                      <line x1="4" y1="18" x2="4.01" y2="18" />
                      <line x1="9" y1="6" x2="20" y2="6" />
                      <line x1="9" y1="12" x2="20" y2="12" />
                      <line x1="9" y1="18" x2="20" y2="18" />
                    </svg>
                  </button>
                  <button
                    className={diffMode === 'unified' ? 'active' : ''}
                    title={t('diffUnifiedTip')}
                    aria-label={t('diffUnifiedTip')}
                    onClick={() => setMode('unified')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <rect x="5" y="3" width="14" height="18" rx="1" />
                      <line x1="9" y1="8" x2="15" y2="8" />
                      <line x1="9" y1="12" x2="15" y2="12" />
                      <line x1="9" y1="16" x2="13" y2="16" />
                    </svg>
                  </button>
                  <button
                    className={diffMode === 'split' ? 'active' : ''}
                    title={t('diffSplitTip')}
                    aria-label={t('diffSplitTip')}
                    onClick={() => setMode('split')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <rect x="3" y="3" width="8" height="18" rx="1" />
                      <rect x="13" y="3" width="8" height="18" rx="1" />
                    </svg>
                  </button>
                </span>
              </div>
              <div className="diff-scroll">
                {loading && !cur ? (
                  <div className="file-diff file-diff-loading">{t('loadingDiff')}</div>
                ) : cur ? (
                  cur.isError ? (
                    <div className="file-diff file-diff-error">{cur.text}</div>
                  ) : (
                    <DiffView text={cur.text} mode={diffMode} showNums={showNums} />
                  )
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
