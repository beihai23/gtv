import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  saveViewport, loadViewport, sanitizeViewport,
  saveDateRange, loadDateRange, sanitizeRangePrefs,
} from './viewpersist';

// vitest runs in a node environment with no localStorage; viewpersist.ts
// reaches it lazily through globalThis, so tests stub an in-memory map per
// test (same harness as persist.test.ts).
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

describe('saveViewport / loadViewport', () => {
  it('save -> load roundtrips the camera transform', () => {
    saveViewport('/repo/a', { k: 2.5, x: -120.5, y: 33 });
    expect(loadViewport('/repo/a')).toEqual({ k: 2.5, x: -120.5, y: 33 });
  });

  it('persists under the gtv_viewport:<repoPath> key; other repos isolated', () => {
    saveViewport('/repo/a', { k: 1, x: 0, y: 0 });
    expect(map.get('gtv_viewport:/repo/a')).toBe('{"k":1,"x":0,"y":0}');
    expect(loadViewport('/repo/b')).toBe(null);
  });

  it('saveViewport never throws when the storage write fails (best-effort contract)', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') } });
    expect(() => saveViewport('/repo/a', { k: 1, x: 0, y: 0 })).not.toThrow();
  });

  it('non-JSON garbage -> null', () => {
    map.set('gtv_viewport:/repo/a', 'not json at all');
    expect(loadViewport('/repo/a')).toBe(null);
  });

  it('valid JSON but missing fields -> null (dirty-data defense)', () => {
    map.set('gtv_viewport:/repo/a', '{"k":1,"x":0}');
    expect(loadViewport('/repo/a')).toBe(null);
  });
});

describe('sanitizeViewport', () => {
  it('accepts a finite positive-k transform', () => {
    expect(sanitizeViewport({ k: 0.5, x: -10, y: 20 })).toEqual({ k: 0.5, x: -10, y: 20 });
  });

  it('rejects k <= 0 (a zero scale would blank the canvas on restore)', () => {
    expect(sanitizeViewport({ k: 0, x: 0, y: 0 })).toBe(null);
    expect(sanitizeViewport({ k: -1, x: 0, y: 0 })).toBe(null);
  });

  it('rejects non-finite and non-number fields', () => {
    expect(sanitizeViewport({ k: Infinity, x: 0, y: 0 })).toBe(null);
    expect(sanitizeViewport({ k: '1', x: 0, y: 0 })).toBe(null);
    expect(sanitizeViewport(null)).toBe(null);
    expect(sanitizeViewport('k=1')).toBe(null);
  });
});

describe('saveDateRange / loadDateRange', () => {
  it('roundtrips the all range with its custom input strings', () => {
    saveDateRange('/repo/a', { range: { kind: 'all' }, customFrom: '', customTo: '' });
    expect(loadDateRange('/repo/a')).toEqual({ range: { kind: 'all' }, customFrom: '', customTo: '' });
  });

  it('roundtrips a preset and a custom range', () => {
    saveDateRange('/repo/a', { range: { kind: 'preset', days: 7 }, customFrom: '2026-01-01', customTo: '' });
    expect(loadDateRange('/repo/a')?.range).toEqual({ kind: 'preset', days: 7 });
    saveDateRange('/repo/a', { range: { kind: 'custom', start: 100, end: 200 }, customFrom: 'a', customTo: 'b' });
    expect(loadDateRange('/repo/a')).toEqual({
      range: { kind: 'custom', start: 100, end: 200 },
      customFrom: 'a',
      customTo: 'b',
    });
  });

  it('persists under the gtv_daterange:<repoPath> key; other repos isolated', () => {
    saveDateRange('/repo/a', { range: { kind: 'preset', days: 30 }, customFrom: '', customTo: '' });
    expect(loadDateRange('/repo/b')).toBe(null);
  });

  it('non-JSON garbage -> null', () => {
    map.set('gtv_daterange:/repo/a', '{{{');
    expect(loadDateRange('/repo/a')).toBe(null);
  });
});

describe('sanitizeRangePrefs', () => {
  it('accepts every DateRange union member with string custom inputs', () => {
    expect(sanitizeRangePrefs({ range: { kind: 'all' }, customFrom: '', customTo: '' })).not.toBe(null);
    expect(sanitizeRangePrefs({ range: { kind: 'preset', days: 90 }, customFrom: '', customTo: '' })).not.toBe(null);
    expect(sanitizeRangePrefs({ range: { kind: 'custom', start: 0, end: 5 }, customFrom: '', customTo: '' })).not.toBe(null);
  });

  it('rejects an out-of-union kind and malformed range fields', () => {
    expect(sanitizeRangePrefs({ range: { kind: 'week' }, customFrom: '', customTo: '' })).toBe(null);
    expect(sanitizeRangePrefs({ range: { kind: 'preset', days: -1 }, customFrom: '', customTo: '' })).toBe(null);
    expect(sanitizeRangePrefs({ range: { kind: 'preset', days: '7' }, customFrom: '', customTo: '' })).toBe(null);
    expect(sanitizeRangePrefs({ range: { kind: 'custom', start: NaN, end: 5 }, customFrom: '', customTo: '' })).toBe(null);
    expect(sanitizeRangePrefs({ range: null, customFrom: '', customTo: '' })).toBe(null);
  });

  it('rejects non-string custom input strings', () => {
    expect(sanitizeRangePrefs({ range: { kind: 'all' }, customFrom: 3, customTo: '' })).toBe(null);
  });
});
