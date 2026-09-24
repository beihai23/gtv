import type { FileChange } from './types';

// Directory-tree assembly for the changed-files list (flat / tree toggle
// in FileChangeList). Pure module: no React, no DOM — unit-tested in
// filetree.test.ts the same way compare.ts / tabs.ts are.

export type FileTreeNode =
  | { kind: 'dir'; name: string; path: string; children: FileTreeNode[] }
  | { kind: 'file'; file: FileChange };

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: FileChange[];
}

/** Build the directory tree for a commit/compare file list.
 *  - Input order is irrelevant; output is sorted: directories first, then
 *    files, alphabetical at every level.
 *  - Single-child directory chains compress into one node whose name is
 *    the joined segment (`src/app` when src/ holds only app/) — the
 *    GitHub convention, so deep Java-style paths stay scannable. */
export function buildFileTree(files: FileChange[]): FileTreeNode[] {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: [] };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segs = file.path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const path = segs.slice(0, i + 1).join('/');
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { name: seg, path, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(file);
  }

  const compress = (dir: MutableDir): void => {
    for (const child of dir.dirs.values()) {
      compress(child);
      // Fold chains: a directory whose only content is one subdirectory
      // merges with it (name accumulates the joined path).
      while (child.files.length === 0 && child.dirs.size === 1) {
        const grand = [...child.dirs.values()][0];
        child.name = `${child.name}/${grand.name}`;
        child.path = grand.path;
        child.dirs = grand.dirs;
        child.files = grand.files;
      }
    }
  };
  compress(root);

  const toNodes = (dir: MutableDir): FileTreeNode[] => [
    ...[...dir.dirs.values()].map(d => ({
      kind: 'dir' as const,
      name: d.name,
      path: d.path,
      children: toNodes(d),
    })),
    ...dir.files.map(file => ({ kind: 'file' as const, file })),
  ];
  return toNodes(root);
}
