import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TERM_HEIGHT,
  TERM_MIN_HEIGHT,
  clampTerminalHeight,
  loadTermHeight,
  saveTermHeight,
} from './terminalSize';

const VIEWPORT = 800;

// vitest runs in plain node by default (no jsdom); the app's localStorage
// convention needs a minimal in-memory stand-in.
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

describe('clampTerminalHeight', () => {
  it('keeps in-range values (rounded)', () => {
    expect(clampTerminalHeight(300, VIEWPORT)).toBe(300);
    expect(clampTerminalHeight(299.6, VIEWPORT)).toBe(300);
  });

  it('clamps up to the minimum', () => {
    expect(clampTerminalHeight(0, VIEWPORT)).toBe(TERM_MIN_HEIGHT);
    expect(clampTerminalHeight(-50, VIEWPORT)).toBe(TERM_MIN_HEIGHT);
  });

  it('clamps down to 60% of the viewport', () => {
    expect(clampTerminalHeight(9999, VIEWPORT)).toBe(480);
    expect(clampTerminalHeight(600, VIEWPORT)).toBe(480);
  });

  it('keeps the minimum on a tiny window instead of collapsing', () => {
    expect(clampTerminalHeight(300, 100)).toBe(TERM_MIN_HEIGHT);
  });

  it('falls back to the default on non-finite input', () => {
    expect(clampTerminalHeight(NaN, VIEWPORT)).toBe(DEFAULT_TERM_HEIGHT);
    expect(clampTerminalHeight(Infinity, VIEWPORT)).toBe(DEFAULT_TERM_HEIGHT);
  });
});

describe('term height persistence', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('round-trips a saved height', () => {
    saveTermHeight(320);
    expect(loadTermHeight(VIEWPORT)).toBe(320);
  });

  it('returns the default when nothing is stored', () => {
    expect(loadTermHeight(VIEWPORT)).toBe(DEFAULT_TERM_HEIGHT);
  });

  it('re-clamps a stale stored height against the current viewport', () => {
    saveTermHeight(600);
    expect(loadTermHeight(VIEWPORT)).toBe(480);
  });
});
