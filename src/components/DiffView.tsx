// Extracted verbatim from CommitDetails.tsx (M3.2 Task 5): the per-file
// unified-diff renderer, shared by CommitDetails and CompareDetails. The
// component body is byte-identical to its old home; only the two export
// keywords were added so importers can reach it.

export interface FileDiffState {
  text: string;
  isError?: boolean;
}

export function DiffView({ text }: { text: string }) {
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
