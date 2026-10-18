import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_DETAILS_WIDTH,
  DETAILS_MIN_WIDTH,
  clampDetailsWidth,
  loadDetailsWidth,
  saveDetailsWidth,
} from './detailSize';

const VIEWPORT = 1000;

// vitest runs in plain node by default (no jsdom); the app's localStorage
// convention needs a minimal in-memory stand-in (same harness as
// terminalSize.test.ts).
beforeAll(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  Object.assign(globalThis, { localStorage: storage });
});

describe('clampDetailsWidth', () => {
  it('keeps in-range values (rounded)', () => {
    expect(clampDetailsWidth(420, VIEWPORT)).toBe(420);
    expect(clampDetailsWidth(420.4, VIEWPORT)).toBe(420);
  });

  it('clamps up to the minimum', () => {
    expect(clampDetailsWidth(0, VIEWPORT)).toBe(DETAILS_MIN_WIDTH);
    expect(clampDetailsWidth(-120, VIEWPORT)).toBe(DETAILS_MIN_WIDTH);
  });

  it('clamps down to 60% of the viewport', () => {
    expect(clampDetailsWidth(9999, VIEWPORT)).toBe(600);
    expect(clampDetailsWidth(650, VIEWPORT)).toBe(600);
  });

  it('keeps the minimum on a tiny window instead of vanishing', () => {
    expect(clampDetailsWidth(300, 200)).toBe(DETAILS_MIN_WIDTH);
  });

  it('falls back to the default on non-finite input', () => {
    expect(clampDetailsWidth(NaN, VIEWPORT)).toBe(DEFAULT_DETAILS_WIDTH);
    expect(clampDetailsWidth(Infinity, VIEWPORT)).toBe(DEFAULT_DETAILS_WIDTH);
  });
});

describe('details width persistence', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('round-trips a saved width', () => {
    saveDetailsWidth(500);
    expect(loadDetailsWidth(VIEWPORT)).toBe(500);
  });

  it('returns the default when nothing is stored', () => {
    expect(loadDetailsWidth(VIEWPORT)).toBe(DEFAULT_DETAILS_WIDTH);
  });

  it('re-clamps a stale stored width against the current viewport', () => {
    saveDetailsWidth(900);
    expect(loadDetailsWidth(VIEWPORT)).toBe(600);
  });

  it('treats garbage as the default', () => {
    localStorage.setItem('gtv_details_width', 'not-a-number');
    expect(loadDetailsWidth(VIEWPORT)).toBe(DEFAULT_DETAILS_WIDTH);
  });
});
