import { describe, it, expect } from 'vitest';
import { buildFileTree, type FileTreeNode } from './filetree';
import type { FileChange } from './types';

function fc(path: string, over: Partial<FileChange> = {}): FileChange {
  return { path, additions: 1, deletions: 1, status: 'M', ...over };
}

function dirNames(nodes: FileTreeNode[]): string[] {
  return nodes.filter(n => n.kind === 'dir').map(n => (n as { name: string }).name);
}
function filePaths(nodes: FileTreeNode[]): string[] {
  return nodes.filter(n => n.kind === 'file').map(n => (n as { file: FileChange }).file.path);
}
function dir(nodes: FileTreeNode[], name: string): FileTreeNode & { kind: 'dir' } {
  const d = nodes.find(n => n.kind === 'dir' && n.name === name);
  if (!d) throw new Error(`dir not found: ${name}`);
  return d as FileTreeNode & { kind: 'dir' };
}

describe('buildFileTree', () => {
  it('returns an empty list for no files', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it('keeps root-level files at the top level', () => {
    const tree = buildFileTree([fc('README.md'), fc('package.json')]);
    expect(dirNames(tree)).toEqual([]);
    expect(filePaths(tree)).toEqual(['package.json', 'README.md']);
  });

  it('groups files under their directory, dirs before files, alphabetical', () => {
    const tree = buildFileTree([fc('z.ts'), fc('src/b.ts'), fc('src/a.ts'), fc('a.md')]);
    expect(tree.map(n => n.kind)).toEqual(['dir', 'file', 'file']);
    expect(filePaths(dir(tree, 'src').children)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(filePaths(tree)).toEqual(['a.md', 'z.ts']);
  });

  it('sorts multiple directories alphabetically regardless of input order', () => {
    const tree = buildFileTree([fc('b/x.ts'), fc('a/x.ts'), fc('c/x.ts')]);
    expect(dirNames(tree)).toEqual(['a', 'b', 'c']);
  });

  it('compresses single-child directory chains into one joined node', () => {
    const tree = buildFileTree([fc('src/components/app/Main.ts')]);
    // src -> components -> app all have a single child: one node.
    const d = dir(tree, 'src/components/app');
    expect(d.path).toBe('src/components/app');
    expect(filePaths(d.children)).toEqual(['src/components/app/Main.ts']);
  });

  it('stops compressing where a directory has both files and subdirs', () => {
    const tree = buildFileTree([fc('src/index.ts'), fc('src/app/main.ts')]);
    // src has a file AND a subdir: no compression past src.
    const src = dir(tree, 'src');
    expect(filePaths(src.children)).toEqual(['src/index.ts']);
    expect(dirNames(src.children)).toEqual(['app']);
  });

  it('stops compressing where a directory has two subdirectories', () => {
    const tree = buildFileTree([fc('src/a/x.ts'), fc('src/b/y.ts')]);
    const src = dir(tree, 'src');
    expect(dirNames(src.children)).toEqual(['a', 'b']);
  });

  it('does not confuse same-prefix directory names (segment split)', () => {
    const tree = buildFileTree([fc('src/a.ts'), fc('src2/b.ts')]);
    expect(dirNames(tree)).toEqual(['src', 'src2']);
  });

  it('keeps per-file metadata intact on file nodes', () => {
    const tree = buildFileTree([fc('d/f.ts', { additions: 42, deletions: 7, status: 'A' })]);
    const f = dir(tree, 'd').children[0];
    expect(f.kind).toBe('file');
    if (f.kind === 'file') {
      expect(f.file.additions).toBe(42);
      expect(f.file.deletions).toBe(7);
      expect(f.file.status).toBe('A');
    }
  });

  it('handles a mixed realistic tree', () => {
    const tree = buildFileTree([
      fc('src/api/routes.ts'),
      fc('src/api/pagination.ts'),
      fc('src/auth/session.ts'),
      fc('docs/api-v2.md'),
      fc('package.json'),
    ]);
    expect(dirNames(tree)).toEqual(['docs', 'src']);
    expect(filePaths(tree)).toEqual(['package.json']);
    const src = dir(tree, 'src');
    expect(dirNames(src.children)).toEqual(['api', 'auth']);
    expect(filePaths(dir(src.children, 'api').children)).toEqual([
      'src/api/pagination.ts',
      'src/api/routes.ts',
    ]);
  });
});
