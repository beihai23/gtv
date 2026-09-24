// Unified-diff parsing for DiffView: turns raw patch text into numbered
// rows, and pairs deletion/addition runs into side-by-side rows. Pure
// module (no React, no DOM) — unit-tested in diffparse.test.ts the same
// way filetree.ts is.

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number on the OLD side (ctx/del rows only). */
  oldNo: number | null;
  /** 1-based line number on the NEW side (ctx/add rows only). */
  newNo: number | null;
  /** Raw line WITHOUT the leading +/-/space prefix. */
  text: string;
}

export interface SplitRow {
  kind: 'ctx' | 'change' | 'hunk' | 'meta';
  left: DiffLine | null;
  right: DiffLine | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse unified-diff text into structured rows. Lines that carry no
 *  diff meaning (diff --git, index, ---/+++ headers, the "\ No newline"
 *  marker) become 'meta' rows with no numbers. Malformed hunk headers
 *  leave numbering at 1 (better a wrong number than a crash). */
export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1, newNo = 1;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      out.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else {
      // 'diff --git', 'index', '\ No newline at end of file', and anything
      // unexpected: shown as-is, numbered nowhere.
      out.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    }
  }
  return out;
}

/** Pair rows for the side-by-side view. Context rows span both panes;
 *  each deletion run pairs with the addition run directly after it
 *  (unified diffs always order deletions first), index-wise; a pure
 *  insertion leaves the left pane empty, a pure deletion the right. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'hunk' || l.kind === 'meta') {
      rows.push({ kind: l.kind, left: l, right: l });
      i++;
    } else if (l.kind === 'ctx') {
      rows.push({ kind: 'ctx', left: l, right: l });
      i++;
    } else {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        rows.push({ kind: 'change', left: dels[k] ?? null, right: adds[k] ?? null });
      }
    }
  }
  return rows;
}
