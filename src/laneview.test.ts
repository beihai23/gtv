import { describe, expect, it } from 'vitest';
import { ACTIVE_MODE_SIZE, modeHiddenLanes } from './laneview';
import type { BranchLane } from './types';

const lane = (name: string, laneIndex: number): BranchLane => ({
  name,
  lane_index: laneIndex,
  color: '#888888',
  is_tag: false,
  fork_point: null,
  merged_into: null,
  is_active: true,
  is_remote: false,
});

const lanes = [lane('main', 0), lane('feat/a', 1), lane('feat/b', 2), lane('chore/c', 3), lane('fix/d', 4), lane('exp/e', 5)];
const HEAD = 'feat/a';
// Activity order: feat/a (HEAD, newest), main, feat/b, chore/c, fix/d, exp/e
const activity = (name: string) =>
  (({ 'feat/a': 60, main: 50, 'feat/b': 40, 'chore/c': 30, 'fix/d': 20, 'exp/e': 10 }) as Record<string, number>)[name] ?? 0;

describe('modeHiddenLanes', () => {
  it("'all' folds nothing", () => {
    expect(modeHiddenLanes('all', lanes, new Set(), HEAD, activity, new Set()).size).toBe(0);
  });

  it("'starred' folds every lane that is not starred", () => {
    const starred = new Set(['feat/b', 'main']);
    const hidden = modeHiddenLanes('starred', lanes, starred, HEAD, activity, new Set());
    expect(hidden.has('feat/b')).toBe(false);
    expect(hidden.has('main')).toBe(false);
    for (const name of ['chore/c', 'fix/d', 'exp/e']) expect(hidden.has(name)).toBe(true);
  });

  it("'starred' keeps HEAD even when it is not starred", () => {
    const hidden = modeHiddenLanes('starred', lanes, new Set(['feat/b']), HEAD, activity, new Set());
    expect(hidden.has(HEAD)).toBe(false);
    expect(hidden.has('feat/b')).toBe(false);
    // No stars at all -> the starred view degenerates to "just HEAD" (the
    // mode button is disabled with zero stars; this is the transient path
    // after unstarring everything while the mode is on).
    const empty = modeHiddenLanes('starred', lanes, new Set(), HEAD, activity, new Set());
    expect(empty.has(HEAD)).toBe(false);
    expect(empty.size).toBe(lanes.length - 1);
  });

  it("'active' keeps the top-N most active lanes plus HEAD", () => {
    const hidden = modeHiddenLanes('active', lanes, new Set(), HEAD, activity, new Set());
    const kept = lanes.map(l => l.name).filter(n => !hidden.has(n));
    // 6 lanes, ACTIVE_MODE_SIZE kept: exactly one folds, the least active.
    expect(kept.length).toBe(ACTIVE_MODE_SIZE);
    expect(kept).toContain('feat/a');
    expect(hidden.has('exp/e')).toBe(true);
    expect(hidden.has('fix/d')).toBe(false);
  });

  it("a manually restored lane survives the mode", () => {
    const hidden = modeHiddenLanes('starred', lanes, new Set(['feat/b']), HEAD, activity, new Set(['exp/e']));
    expect(hidden.has('exp/e')).toBe(false);
  });

  it("never folds EVERY alive lane (a mode that blanks the canvas is a no-op)", () => {
    // Stars pointing only at nonexistent lanes: HEAD still survives, and
    // the fold set can never equal the whole alive list.
    const hidden = modeHiddenLanes('starred', lanes, new Set(['gone-branch']), HEAD, activity, new Set());
    expect(hidden.has(HEAD)).toBe(false);
    expect(hidden.size).toBeLessThan(lanes.length);
    // The absolute guard: a keep-set missing from aliveLanes entirely must
    // not fold 100%.
    const blank = modeHiddenLanes('starred', [], new Set(['x']), null, activity, new Set());
    expect(blank.size).toBe(0);
  });
});
