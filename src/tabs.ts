// Pure tab-shell state (multi-repo-tabs Task 5): grouping the flat
// open-repo list into commondir (worktree-family) groups, choosing the
// next active tab after a close, and the localStorage restore/persist
// pair. No React, no Tauri -- App.tsx owns the effects and IPC. repo ids
// are runtime-only (they change across restarts), so persisted state is
// paths; the commondir rides along so a restored tab can re-group without
// waiting for the backend round-trip.
//
// localStorage is reached lazily through globalThis and every access is
// defensive -- vitest runs in a node environment with no storage, and
// real-world stored values may be corrupt (persist.ts pattern).

export interface TabInfo {
  repoId: number;
  path: string;
  commondir: string;
}

export const TABS_KEY = 'gtv_tabs';
export const LEGACY_LATEST_KEY = 'gtv_latest_repo';

const store = (): Storage | undefined => globalThis.localStorage;

/** Which tab to activate after closing `closedIdx` (an index into the
 *  PRE-close list): the right neighbor first (browser-tab muscle memory),
 *  else the left one, else -1 when no tabs remain. The result indexes the
 *  pre-close list -- callers resolve it to a repoId BEFORE filtering. */
export function nextActiveAfterClose(tabs: TabInfo[], closedIdx: number): number {
  if (closedIdx < 0 || closedIdx >= tabs.length) return -1;
  if (tabs.length <= 1) return -1;
  if (closedIdx + 1 < tabs.length) return closedIdx + 1;
  return closedIdx - 1;
}

/** Next active repo id after closing `closedRepoId`: closing the ACTIVE tab
 *  picks the right-then-left neighbor (pre-close indices); closing a
 *  background tab keeps the current active. null = the shell empties.
 *  (Task-5 review Fix-2: closeTab used to apply the neighbor rule
 *  unconditionally, so the x on a background tab's group jumped the
 *  activated view to the closed tab's neighbor instead of staying put.) */
export function nextActiveRepoId(
  tabs: TabInfo[],
  activeRepoId: number | null,
  closedRepoId: number,
): number | null {
  if (closedRepoId !== activeRepoId) return activeRepoId;
  const closedIdx = tabs.findIndex(tb => tb.repoId === closedRepoId);
  const nextIdx = nextActiveAfterClose(tabs, closedIdx);
  return nextIdx >= 0 ? tabs[nextIdx].repoId : null;
}

interface RestoredTabs {
  paths: string[];
  activeIdx: number;
}

/** Read the persisted tab list (spec 5.4): gtv_tabs wins; a legacy
 *  gtv_latest_repo single value migrates into a one-member restore. The
 *  legacy key is deleted on every successful read path (including the
 *  gtv_tabs-wins one -- once a tab list exists it is the sole authority),
 *  making the migration read-once. Null when nothing restorable exists.
 *  Out-of-range active indices are the caller's to clamp (it knows how
 *  many paths actually re-opened). */
export function migrateRestore(): RestoredTabs | null {
  let storage: Storage | undefined;
  try {
    storage = store();
  } catch {
    return null;
  }
  if (!storage) return null;

  try {
    const raw = storage.getItem(TABS_KEY);
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      const members = extractMemberPaths(parsed);
      if (members !== null && members.length > 0) {
        storage.removeItem(LEGACY_LATEST_KEY);
        return { paths: members, activeIdx: extractActiveIdx(parsed) };
      }
    }
  } catch {
    // Corrupt gtv_tabs: fall through to the legacy key, then to nothing.
  }

  try {
    const legacy = storage.getItem(LEGACY_LATEST_KEY);
    if (legacy) {
      storage.removeItem(LEGACY_LATEST_KEY);
      return { paths: [legacy], activeIdx: 0 };
    }
  } catch {
    // Best-effort like every storage access here.
  }
  return null;
}

/** Persist the tab list as { members: [{path, commondir}], active }. The
 *  repoId is deliberately NOT persisted (runtime-only). Best-effort: a
 *  full or unavailable storage must never break the UI. */
export function persistTabs(tabs: TabInfo[], activeIdx: number): void {
  try {
    store()?.setItem(
      TABS_KEY,
      JSON.stringify({
        members: tabs.map(t => ({ path: t.path, commondir: t.commondir })),
        active: activeIdx,
      }),
    );
  } catch {
    // Storage unavailable or full: persistence is best-effort, never fatal.
  }
}

/** Strict members extraction: [{path}] arrays of non-empty strings, or
 *  null for anything else (dirty-data defense). */
function extractMemberPaths(parsed: unknown): string[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const members = (parsed as { members?: unknown }).members;
  if (!Array.isArray(members)) return null;
  const paths: string[] = [];
  for (const m of members) {
    if (typeof m !== 'object' || m === null) return null;
    const p = (m as { path?: unknown }).path;
    if (typeof p !== 'string' || p.length === 0) return null;
    paths.push(p);
  }
  return paths;
}

function extractActiveIdx(parsed: unknown): number {
  const active = (parsed as { active?: unknown }).active;
  return typeof active === 'number' && Number.isFinite(active) && active >= 0
    ? Math.floor(active)
    : 0;
}
