import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { saveSelection, loadSelection, restoreSelection, savePinned, loadPinned } from './persist';

// vitest runs in a node environment with no localStorage; persist.ts reaches
// it lazily through globalThis, so tests stub an in-memory map per test.
let map: Map<string, string>;

beforeEach(() => {
  map = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- tests ----------------------------------------------------------------

describe('saveSelection / loadSelection', () => {
  it('save -> load roundtrips the names array', () => {
    saveSelection('/repo/a', ['main', 'feat']);
    expect(loadSelection('/repo/a')).toEqual(['main', 'feat']);
  });

  it('an explicitly saved empty selection survives the roundtrip', () => {
    // "none selected" is a real choice and must persist as [] (spec 4.4)
    saveSelection('/repo/a', []);
    expect(loadSelection('/repo/a')).toEqual([]);
  });

  it('persists under the gtv_branch_sel:<repoPath> key; other repos isolated', () => {
    saveSelection('/repo/a', ['main']);
    expect(map.get('gtv_branch_sel:/repo/a')).toBe('["main"]');
    expect(loadSelection('/repo/b')).toBe(null);
  });

  it('saveSelection never throws when the storage write fails (best-effort contract)', () => {
    // Quota exceeded / storage disabled must not break the UI; the throwing
    // stub pins the swallow path against a future "helpful" rethrow refactor.
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') } });
    expect(() => saveSelection('/repo/a', ['main'])).not.toThrow();
  });

  it('valid JSON but not an array -> null (dirty-data defense)', () => {
    map.set('gtv_branch_sel:/repo/a', '{"a":1}');
    expect(loadSelection('/repo/a')).toBe(null);
  });

  it('array containing non-strings -> null (dirty-data defense)', () => {
    map.set('gtv_branch_sel:/repo/a', '["main", 3, null]');
    expect(loadSelection('/repo/a')).toBe(null);
  });

  it('non-JSON garbage -> null', () => {
    map.set('gtv_branch_sel:/repo/a', 'not json at all');
    expect(loadSelection('/repo/a')).toBe(null);
  });
});

describe('restoreSelection', () => {
  const available = ['main', 'dev', 'feat', 'release'];

  it('partial intersection returns the subset ordered by `available`', () => {
    // saved order is scrambled; the result must follow available's order
    expect(restoreSelection(['release', 'main'], available)).toEqual(['main', 'release']);
  });

  it('names missing from available drop out (branch deleted since last visit)', () => {
    expect(restoreSelection(['main', 'gone'], available)).toEqual(['main']);
  });

  it('empty intersection -> null (fall back to the default all-selected state)', () => {
    expect(restoreSelection(['gone', 'also-gone'], available)).toBe(null);
  });

  it('intersection equals the full available set -> null (default state, no rebuild)', () => {
    expect(restoreSelection(['feat', 'main', 'release', 'dev'], available)).toBe(null);
  });

  it('saved null -> null (nothing ever persisted)', () => {
    expect(restoreSelection(null, available)).toBe(null);
  });
});

describe('savePinned / loadPinned', () => {
  it('save -> load roundtrips the names array', () => {
    savePinned('/repo/a', ['main', 'feat']);
    expect(loadPinned('/repo/a')).toEqual(['main', 'feat']);
  });

  it('an explicitly saved empty pin set survives the roundtrip', () => {
    // Unpinning the last branch is real state -- it must NOT resurrect
    // the previous set on reload, so [] is written and read back as [].
    savePinned('/repo/a', ['main']);
    savePinned('/repo/a', []);
    expect(loadPinned('/repo/a')).toEqual([]);
  });

  it('persists under its own key, isolated from the selection and other repos', () => {
    saveSelection('/repo/a', ['main']);
    savePinned('/repo/a', ['feat']);
    expect(map.get('gtv_branch_pins:/repo/a')).toBe('["feat"]');
    expect(map.get('gtv_branch_sel:/repo/a')).toBe('["main"]');
    expect(loadPinned('/repo/b')).toBe(null);
  });

  it('valid JSON but not an array -> null (dirty-data defense)', () => {
    map.set('gtv_branch_pins:/repo/a', '{"a":1}');
    expect(loadPinned('/repo/a')).toBe(null);
  });

  it('array containing non-strings -> null (dirty-data defense)', () => {
    map.set('gtv_branch_pins:/repo/a', '["main", 3]');
    expect(loadPinned('/repo/a')).toBe(null);
  });
});
