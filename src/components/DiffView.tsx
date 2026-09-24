import { useMemo } from 'react';
import { parseDiff, toSplitRows, type DiffLine } from '../diffparse';

// Unified-diff renderer for the wide split view's right pane. Two modes:
// 'unified' (single column, the classic patch) and 'split' (old on the
// left, new on the right). Line numbers are optional in both. The raw
// text is parsed by the pure diffparse module (unit-tested); this
// component is pure presentation.

export interface FileDiffState {
  text: string;
  isError?: boolean;
}

export type DiffMode = 'unified' | 'split';

interface DiffViewProps {
  text: string;
  mode?: DiffMode;
  showNums?: boolean;
}

function NumCell({ n }: { n: number | null }) {
  return <span className="diff-num">{n ?? ''}</span>;
}

function UnifiedRows({ lines, showNums }: { lines: DiffLine[]; showNums: boolean }) {
  return (
    <>
      {lines.map((l, i) => {
        if (l.kind === 'hunk') {
          return <div key={i} className="diff-line diff-line-hunk"><span className="diff-code">{l.text}</span></div>;
        }
        if (l.kind === 'meta') {
          return <div key={i} className="diff-line diff-line-meta"><span className="diff-code">{l.text || ' '}</span></div>;
        }
        const cls = l.kind === 'add' ? ' diff-line-add' : l.kind === 'del' ? ' diff-line-del' : '';
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
        return (
          <div key={i} className={`diff-line${cls}`}>
            {showNums && <NumCell n={l.oldNo} />}
            {showNums && <NumCell n={l.newNo} />}
            <span className="diff-sign">{sign}</span>
            <span className="diff-code">{l.text || ' '}</span>
          </div>
        );
      })}
    </>
  );
}

function SplitRows({ lines, showNums }: { lines: DiffLine[]; showNums: boolean }) {
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  // Two independent panes: each scrolls horizontally on its own (long
  // aligned code never bleeds across the divider), every pane renders the
  // same row count at one line each, so left/right rows stay vertically
  // aligned under the single outer vertical scrollbar.
  const cell = (r: (typeof rows)[number], side: 'left' | 'right') => {
    const l = side === 'left' ? r.left : r.right;
    if (r.kind === 'hunk') {
      return <div className="diff-line diff-line-hunk"><span className="diff-code">{r.left!.text}</span></div>;
    }
    if (r.kind === 'meta') {
      return <div className="diff-line diff-line-meta"><span className="diff-code">{r.left!.text || ' '}</span></div>;
    }
    const changed = side === 'left' ? l?.kind === 'del' : l?.kind === 'add';
    const cls = changed ? (side === 'left' ? ' diff-line-del' : ' diff-line-add') : '';
    return (
      <div className={`diff-line${cls}${l ? '' : ' split-empty'}`}>
        {showNums && <NumCell n={l ? (side === 'left' ? l.oldNo : l.newNo) : null} />}
        <span className="diff-code">{l?.text ?? ''}</span>
      </div>
    );
  };
  return (
    <>
      <div className="split-pane">{rows.map((r, i) => <div key={i}>{cell(r, 'left')}</div>)}</div>
      <div className="split-pane">{rows.map((r, i) => <div key={i}>{cell(r, 'right')}</div>)}</div>
    </>
  );
}

export function DiffView({ text, mode = 'unified', showNums = true }: DiffViewProps) {
  const lines = useMemo(() => parseDiff(text), [text]);
  return (
    <div className={`file-diff mode-${mode}`}>
      {mode === 'unified'
        ? <UnifiedRows lines={lines} showNums={showNums} />
        : <SplitRows lines={lines} showNums={showNums} />}
    </div>
  );
}
