import { describe, it, expect } from 'vitest';
import { parseDiff, toSplitRows } from './diffparse';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index cf1ed74..285e077 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -2,6 +2,7 @@ package app',
  ' import (',
  '-\t"old"',
  '+\t"new"',
  '+\t"newer"',
  ' \t"fmt"',
  ' ',
  '@@ -20,3 +21,2 @@ func f() {',
  '-gone one',
  '-gone two',
  '+replacement',
  ' tail',
  '\\ No newline at end of file',
].join('\n');

describe('parseDiff', () => {
  const rows = parseDiff(PATCH);

  it('marks header lines as meta with no numbers', () => {
    expect(rows.slice(0, 4).map(r => r.kind)).toEqual(['meta', 'meta', 'meta', 'meta']);
    expect(rows[0].text).toBe('diff --git a/src/app.ts b/src/app.ts');
  });

  it('tracks old/new line numbers across a hunk', () => {
    // @@ -2,6 +2,7 @@: ctx starts old 2, new 2.
    const ctx1 = rows[5];
    expect(ctx1).toMatchObject({ kind: 'ctx', oldNo: 2, newNo: 2, text: 'import (' });
    const del = rows[6];
    expect(del).toMatchObject({ kind: 'del', oldNo: 3, newNo: null, text: '\t"old"' });
    const add1 = rows[7];
    expect(add1).toMatchObject({ kind: 'add', oldNo: null, newNo: 3, text: '\t"new"' });
    const add2 = rows[8];
    expect(add2.newNo).toBe(4);
    const ctx2 = rows[9];
    expect(ctx2).toMatchObject({ kind: 'ctx', oldNo: 4, newNo: 5 });
    // ' ' alone is still a context line (its prefix IS the space).
    const ctx3 = rows[10];
    expect(ctx3).toMatchObject({ kind: 'ctx', oldNo: 5, newNo: 6 });
  });

  it('resets numbering at the next hunk header', () => {
    const del = rows.find(r => r.kind === 'del' && r.text === 'gone one');
    expect(del).toMatchObject({ oldNo: 20, newNo: null });
    const add = rows.find(r => r.kind === 'add' && r.text === 'replacement');
    expect(add).toMatchObject({ oldNo: null, newNo: 21 });
    const tail = rows.find(r => r.kind === 'ctx' && r.text === 'tail');
    expect(tail).toMatchObject({ oldNo: 22, newNo: 22 });
  });

  it('treats the no-newline marker as meta', () => {
    expect(rows[rows.length - 1].kind).toBe('meta');
  });

  it('keeps a leading prefix inside content when the sign is the whole line', () => {
    const rows2 = parseDiff('@@ -1,1 +1,2 @@\n-old\n+\n ctx');
    expect(rows2[2]).toMatchObject({ kind: 'add', text: '' });
  });

  it('handles a malformed hunk header without crashing', () => {
    const rows3 = parseDiff('@@ broken\n+hello');
    expect(rows3[1]).toMatchObject({ kind: 'add', newNo: 1 });
  });
});

describe('toSplitRows', () => {
  const split = toSplitRows(parseDiff(PATCH));

  it('spans meta and hunk rows across both panes', () => {
    expect(split[0].kind).toBe('meta');
    expect(split[0].left).toBe(split[0].right);
    const hunk = split.find(r => r.kind === 'hunk');
    expect(hunk?.left).toBe(hunk?.right);
  });

  it('puts context rows on both sides', () => {
    const ctx = split.find(r => r.kind === 'ctx');
    expect(ctx?.left?.text).toBe(ctx?.right?.text);
  });

  it('pairs a del/add change block index-wise, padding the short side', () => {
    // del "old" (1) vs adds "new"+"newer" (2): second row has empty left.
    const block = split.filter(r => r.kind === 'change' && r.left?.text !== 'gone one' && r.left?.text !== 'gone two' && (r.left || r.right));
    const first = block.find(r => r.left?.text === '\t"old"');
    expect(first?.right?.text).toBe('\t"new"');
    const second = block[block.indexOf(first!) + 1];
    expect(second.left).toBeNull();
    expect(second.right?.text).toBe('\t"newer"');
  });

  it('pairs pure deletions with an empty right pane', () => {
    const g1 = split.find(r => r.left?.text === 'gone one');
    expect(g1?.right?.text).toBe('replacement');
    const g2 = split[split.indexOf(g1!) + 1];
    expect(g2.left?.text).toBe('gone two');
    expect(g2.right).toBeNull();
  });

  it('handles pure insertions with an empty left pane', () => {
    const rows = toSplitRows(parseDiff('@@ -1,1 +1,3 @@\n ctx\n+a\n+b'));
    expect(rows[2]).toMatchObject({ kind: 'change', left: null });
    expect(rows[2].right?.text).toBe('a');
    expect(rows[3]).toMatchObject({ kind: 'change', left: null });
  });
});
