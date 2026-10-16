// Per-repo view memory: the timeline camera (zoom k + pan x/y) and the
// date-range display filter, one localStorage key per repo path. Same
// defensive shape as persist.ts (M2.4): localStorage is reached lazily
// through globalThis and every access is guarded -- storage may be absent
// (node tests) or hold corrupt data.

import type { DateRange } from './daterange';

const viewportKey = (repoPath: string) => `gtv_viewport:${repoPath}`;
const rangeKey = (repoPath: string) => `gtv_daterange:${repoPath}`;

const store = (): Storage | undefined => globalThis.localStorage;

export interface Viewport {
  /** Zoom scale (d3 ZoomTransform.k); pan is stored in screen px. */
  k: number;
  x: number;
  y: number;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Validate an untrusted parsed value as a usable camera; null when anything
 *  is off (a k of 0 would blank the canvas on restore). Callers still clamp
 *  k into the zoom behavior's scaleExtent. */
export function sanitizeViewport(v: unknown): Viewport | null {
  if (typeof v !== 'object' || v === null) return null;
  const { k, x, y } = v as Record<string, unknown>;
  if (!isFiniteNumber(k) || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (k <= 0) return null;
  return { k, x, y };
}

export function saveViewport(repoPath: string, t: Viewport): void {
  try {
    store()?.setItem(viewportKey(repoPath), JSON.stringify(t));
  } catch {
    // Storage unavailable or full: persistence is best-effort, never fatal.
  }
}

export function loadViewport(repoPath: string): Viewport | null {
  try {
    const raw = store()?.getItem(viewportKey(repoPath));
    if (raw == null) return null;
    return sanitizeViewport(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A saved date-range pref: the range itself plus the Custom inputs' raw
 *  'YYYY-MM-DD' strings, so preset switches never lose what the user typed. */
export interface RangePrefs {
  range: DateRange;
  customFrom: string;
  customTo: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Validate an untrusted parsed value as a date-range pref; null unless the
 *  range matches the DateRange union exactly -- an out-of-union `kind` would
 *  fall through the pipeline's switches and corrupt the display copy. */
export function sanitizeRangePrefs(v: unknown): RangePrefs | null {
  if (typeof v !== 'object' || v === null) return null;
  const { range, customFrom, customTo } = v as Record<string, unknown>;
  if (typeof range !== 'object' || range === null) return null;
  const r = range as Record<string, unknown>;
  let out: DateRange;
  if (r.kind === 'all') {
    out = { kind: 'all' };
  } else if (r.kind === 'preset' && isFiniteNumber(r.days) && r.days > 0) {
    out = { kind: 'preset', days: r.days };
  } else if (r.kind === 'custom' && isFiniteNumber(r.start) && isFiniteNumber(r.end)) {
    out = { kind: 'custom', start: r.start, end: r.end };
  } else {
    return null;
  }
  if (!isStr(customFrom) || !isStr(customTo)) return null;
  return { range: out, customFrom, customTo };
}

export function saveDateRange(repoPath: string, prefs: RangePrefs): void {
  try {
    store()?.setItem(rangeKey(repoPath), JSON.stringify(prefs));
  } catch {
    // Best-effort, never fatal.
  }
}

export function loadDateRange(repoPath: string): RangePrefs | null {
  try {
    const raw = store()?.getItem(rangeKey(repoPath));
    if (raw == null) return null;
    return sanitizeRangePrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}
