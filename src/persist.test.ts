import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { savePinned, loadPinned } from './persist';

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

  it('persists under its own key, isolated from other repos', () => {
    savePinned('/repo/a', ['feat']);
    expect(map.get('gtv_branch_pins:/repo/a')).toBe('["feat"]');
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
