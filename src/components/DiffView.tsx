import { useMemo, useRef } from 'react';
import { parseDiff, toSplitRows, type DiffLine, type SplitRow } from '../diffparse';

// Unified-diff renderer for the wide split view's right pane. Two modes:
// 'unified' (single column, the classic patch) and 'split' (old on the
// left, new on the right, horizontal scrolling LINKED across both panes).
// Line numbers are optional in both. The raw text is parsed by the pure
// diffparse module (unit-tested); this component is pure presentation.
//
// Row structure (both modes): a block .diff-line for stacking, wrapping a
// shrink-wrapped .diff-line-inner (inline-flex, min-width 100%) that
// carries the add/del/empty background. This is the WebKit-safe pattern:
// width:max-content on a flex row mis-measures in WKWebView, which let
// long lines spill out of their background tint; inline-flex measures
// correctly everywhere and still stretches short rows to full width.

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
          return (
            <div key={i} className="diff-line">
              <span className="diff-line-inner diff-line-hunk"><span className="diff-code">{l.text}</span></span>
            </div>
          );
        }
        if (l.kind === 'meta') {
          return (
            <div key={i} className="diff-line">
              <span className="diff-line-inner diff-line-meta"><span className="diff-code">{l.text || ' '}</span></span>
            </div>
          );
        }
        const cls = l.kind === 'add' ? ' diff-line-add' : l.kind === 'del' ? ' diff-line-del' : '';
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
        return (
          <div key={i} className="diff-line">
            <span className={`diff-line-inner${cls}`}>
              {showNums && <NumCell n={l.oldNo} />}
              {showNums && <NumCell n={l.newNo} />}
              <span className="diff-sign">{sign}</span>
              <span className="diff-code">{l.text || ' '}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}

function SplitRows({ lines, showNums }: { lines: DiffLine[]; showNums: boolean }) {
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // Linked horizontal scrolling: panes stay on the same code column, so
  // aligned Go/C declarations read side by side after any scroll. The
  // re-entrancy flag breaks the A->B->A feedback cycle (the echoed write
  // fires the other's onScroll synchronously).
  const syncing = useRef(false);
  const onScroll = (src: 'left' | 'right') => () => {
    if (syncing.current) return;
    const a = leftRef.current, b = rightRef.current;
    if (!a || !b) return;
    syncing.current = true;
    if (src === 'left') b.scrollLeft = a.scrollLeft;
    else a.scrollLeft = b.scrollLeft;
    syncing.current = false;
  };

  const cell = (r: SplitRow, side: 'left' | 'right') => {
    const l = side === 'left' ? r.left : r.right;
    if (r.kind === 'hunk') {
      return (
        <div className="diff-line">
          <span className="diff-line-inner diff-line-hunk"><span className="diff-code">{r.left!.text}</span></span>
        </div>
      );
    }
    if (r.kind === 'meta') {
      return (
        <div className="diff-line">
          <span className="diff-line-inner diff-line-meta"><span className="diff-code">{r.left!.text || ' '}</span></span>
        </div>
      );
    }
    const changed = side === 'left' ? l?.kind === 'del' : l?.kind === 'add';
    const cls = changed ? (side === 'left' ? ' diff-line-del' : ' diff-line-add') : '';
    return (
      <div className="diff-line">
        <span className={`diff-line-inner${cls}${l ? '' : ' split-empty'}`}>
          {showNums && <NumCell n={l ? (side === 'left' ? l.oldNo : l.newNo) : null} />}
          <span className="diff-code">{l?.text ?? ''}</span>
        </span>
      </div>
    );
  };
  return (
    <>
      <div className="split-pane" ref={leftRef} onScroll={onScroll('left')}>
        {rows.map((r, i) => <div key={i}>{cell(r, 'left')}</div>)}
      </div>
      <div className="split-pane" ref={rightRef} onScroll={onScroll('right')}>
        {rows.map((r, i) => <div key={i}>{cell(r, 'right')}</div>)}
      </div>
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
