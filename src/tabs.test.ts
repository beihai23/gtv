import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  groupTabsByCommondir,
  migrateRestore,
  nextActiveAfterClose,
  persistTabs,
  TABS_KEY,
  LEGACY_LATEST_KEY,
} from './tabs';
import type { TabInfo } from './tabs';

// vitest runs in a node environment with no localStorage; tabs.ts reaches
// it lazily through globalThis, so tests stub an in-memory map per test
// (persist.test.ts pattern).
let map: Map<string, string>;

beforeEach(() => {
  map = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tab = (repoId: number, path: string, commondir: string): TabInfo => ({
  repoId,
  path,
  commondir,
});

// --- groupTabsByCommondir --------------------------------------------------

describe('groupTabsByCommondir', () => {
  it('groups by commondir, groups and members in insertion order', () => {
    // Interleaved families: A's group must stay first (first insertion),
    // and each group keeps its members in the order they were opened.
    const tabs = [
      tab(1, '/a', 'CD-A'),
      tab(2, '/x', 'CD-X'),
      tab(3, '/b', 'CD-A'),
      tab(4, '/y', 'CD-X'),
      tab(5, '/c', 'CD-A'),
    ];
    const groups = groupTabsByCommondir(tabs);
    expect(groups.map(g => g.map(t => t.repoId))).toEqual([[1, 3, 5], [2, 4]]);
  });

  it('an empty tab list groups into nothing', () => {
    expect(groupTabsByCommondir([])).toEqual([]);
  });
});

// --- nextActiveAfterClose --------------------------------------------------

describe('nextActiveAfterClose', () => {
  const tabs = [tab(1, '/a', 'A'), tab(2, '/b', 'B'), tab(3, '/c', 'C')];

  it('closing the FIRST of several activates the right neighbor', () => {
    expect(nextActiveAfterClose(tabs, 0)).toBe(1);
  });

  it('closing a MIDDLE tab activates the right neighbor', () => {
    expect(nextActiveAfterClose(tabs, 1)).toBe(2);
  });

  it('closing the LAST of several falls back to the left neighbor', () => {
    expect(nextActiveAfterClose(tabs, 2)).toBe(1);
  });

  it('closing the ONLY tab leaves nobody to activate (-1)', () => {
    expect(nextActiveAfterClose([tab(1, '/a', 'A')], 0)).toBe(-1);
  });

  it('an out-of-range index is inert (-1)', () => {
    expect(nextActiveAfterClose(tabs, 7)).toBe(-1);
    expect(nextActiveAfterClose(tabs, -1)).toBe(-1);
  });
});

// --- migrateRestore / persistTabs -------------------------------------------

describe('migrateRestore / persistTabs', () => {
  it('persist -> migrate roundtrips paths and active index', () => {
    const tabs = [tab(1, '/a', 'CD-A'), tab(2, '/b', 'CD-B')];
    persistTabs(tabs, 1);
    expect(migrateRestore()).toEqual({ paths: ['/a', '/b'], activeIdx: 1 });
  });

  it('persist writes the documented gtv_tabs shape', () => {
    persistTabs([tab(7, '/w', 'CD-W')], 0);
    expect(JSON.parse(map.get(TABS_KEY) ?? '{}')).toEqual({
      members: [{ path: '/w', commondir: 'CD-W' }],
      active: 0,
    });
  });

  it('both keys present: gtv_tabs wins and the legacy key is retired', () => {
    map.set(LEGACY_LATEST_KEY, '/legacy');
    persistTabs([tab(1, '/fresh', 'CD-F')], 0);
    const restored = migrateRestore();
    expect(restored).toEqual({ paths: ['/fresh'], activeIdx: 0 });
    expect(map.has(LEGACY_LATEST_KEY)).toBe(false);
  });

  it('only the legacy key: migrates as a single-member restore, key deleted after read', () => {
    map.set(LEGACY_LATEST_KEY, '/legacy');
    expect(migrateRestore()).toEqual({ paths: ['/legacy'], activeIdx: 0 });
    expect(map.has(LEGACY_LATEST_KEY)).toBe(false);
    // Read-once semantics: the second restore finds nothing.
    expect(migrateRestore()).toBe(null);
  });

  it('neither key: null', () => {
    expect(migrateRestore()).toBe(null);
  });

  it('corrupt gtv_tabs falls through to the legacy key', () => {
    map.set(TABS_KEY, 'not json at all');
    map.set(LEGACY_LATEST_KEY, '/legacy');
    expect(migrateRestore()).toEqual({ paths: ['/legacy'], activeIdx: 0 });
  });

  it('an empty members list restores nothing', () => {
    map.set(TABS_KEY, JSON.stringify({ members: [], active: 0 }));
    expect(migrateRestore()).toBe(null);
  });

  it('a non-number active falls back to 0; a negative one too', () => {
    map.set(TABS_KEY, JSON.stringify({
      members: [{ path: '/a', commondir: 'A' }, { path: '/b', commondir: 'B' }],
      active: 'one',
    }));
    expect(migrateRestore()).toEqual({ paths: ['/a', '/b'], activeIdx: 0 });
    map.set(TABS_KEY, JSON.stringify({
      members: [{ path: '/a', commondir: 'A' }],
      active: -3,
    }));
    expect(migrateRestore()).toEqual({ paths: ['/a'], activeIdx: 0 });
  });

  it('persistTabs never throws when the storage write fails (best-effort contract)', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') } });
    expect(() => persistTabs([tab(1, '/a', 'A')], 0)).not.toThrow();
  });
});
