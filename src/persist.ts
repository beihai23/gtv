// Branch-selection persistence (spec M2.4): one localStorage key per repo
// path holding a JSON string[]. localStorage is reached lazily through
// globalThis and every access is defensive -- vitest runs in a node
// environment with no storage, and real-world stored values may be corrupt.

const key = (repoPath: string) => `gtv_branch_sel:${repoPath}`;

// Pinned branches (the lens's durable "branches I care about" set): same
// storage shape as the selection, separate key. ONE semantic difference --
// an empty array is real state ("unpinned everything"), so it IS written;
// skipping the write would resurrect the old set after the user unpins
// their last branch and reloads.
const pinsKey = (repoPath: string) => `gtv_branch_pins:${repoPath}`;

const store = (): Storage | undefined => globalThis.localStorage;

/** Persist the current selection as-is. Callers guard against writing an
 *  empty array (that is transient session state); this function writes
 *  whatever it is given. */
export function saveSelection(repoPath: string, names: string[]): void {
  try {
    store()?.setItem(key(repoPath), JSON.stringify(names));
  } catch {
    // Storage unavailable or full: persistence is best-effort, never fatal.
  }
}

/** Read the saved selection; null when absent, unreadable, or not a JSON
 *  array of strings (dirty-data defense). */
export function loadSelection(repoPath: string): string[] | null {
  try {
    const raw = store()?.getItem(key(repoPath));
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(n => typeof n !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Saved (intersect) available, order preserved from `available`; null when
 *  saved is null, the intersection is empty, OR it equals the full set
 *  (default state -- no restore rebuild needed). Length equality is a sound
 *  full-set test: every intersection member is by construction in available. */
export function restoreSelection(saved: string[] | null, available: string[]): string[] | null {
  if (!saved) return null;
  const savedSet = new Set(saved);
  const intersection = available.filter(n => savedSet.has(n));
  if (intersection.length === 0 || intersection.length === available.length) return null;
  return intersection;
}

/** Persist the pin set as-is, including the empty set (see pinsKey). */
export function savePinned(repoPath: string, names: string[]): void {
  try {
    store()?.setItem(pinsKey(repoPath), JSON.stringify(names));
  } catch {
    // Best-effort, never fatal.
  }
}

/** Read the saved pin set; null when absent or not a JSON string[]. */
export function loadPinned(repoPath: string): string[] | null {
  try {
    const raw = store()?.getItem(pinsKey(repoPath));
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(n => typeof n !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}
