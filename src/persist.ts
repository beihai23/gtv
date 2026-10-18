// Pinned-branch (star) persistence: one localStorage key per repo path
// holding a JSON string[]. localStorage is reached lazily through
// globalThis and every access is defensive -- vitest runs in a node
// environment with no storage, and real-world stored values may be corrupt.
//
// The branch include-set is deliberately NOT persisted (it used to live in
// gtv_branch_sel): a persisted inclusion snapshot locked every newer branch
// out of the view, so the include-set is session-only now and every mount
// starts full. Day-to-day personalization lives in the stars and the
// one-click view modes.

const pinsKey = (repoPath: string) => `gtv_branch_pins:${repoPath}`;

const store = (): Storage | undefined => globalThis.localStorage;

/** Persist the pin set as-is, including the empty set -- unpinning the last
 *  branch is real state; skipping the write would resurrect the old set on
 *  reload. */
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
