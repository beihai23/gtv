import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import './App.css';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsDialog } from './components/SettingsDialog';
import RepoView from './RepoView';
import {
  openRepository,
  closeRepository,
  setActiveRepository,
} from './api';
import {
  groupTabsByCommondir,
  migrateRestore,
  nextActiveRepoId,
  persistTabs,
} from './tabs';
import type { TabInfo } from './tabs';
import { recordFrontendError } from './issueContext';
import { useSettings } from './settings';
import type { GitData, OpenedRepo, RepoChanged, WorktreeMember } from './types';

const SHOW_TAGS_KEY = 'gtv_show_tags';

// Caught values are `unknown`; the issue-report ring buffer wants the message.
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Global shell + tab state machine (multi-repo-tabs Task 5): App owns the
// flat open-repo list, the active repo id (indices are derived -- repo ids
// stay stable across closes while indices shift), per-repo worktree-family
// snapshots, and every open entry. ONE openTab(path) funnels all
// path-based sources (picker, restore, lazy second-level chips, Task 6's
// drag-drop); the backend's already_open semantics own the dedup decision.
// RepoViews stay mounted with display:none for inactive tabs (keep-alive:
// selection, viewport, and terminal all survive a switch).
function App() {
  const { t, showStaleBranches } = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [showIssueReport, setShowIssueReport] = useState(false);

  // Cmd/Ctrl + , toggles the settings dialog (macOS convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(s => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Version-tag flood control: hides tag chips from the toolbar and panel.
  const [showTags, setShowTags] = useState(() => localStorage.getItem(SHOW_TAGS_KEY) !== '0');
  const toggleShowTags = useCallback(() => {
    setShowTags(v => {
      localStorage.setItem(SHOW_TAGS_KEY, v ? '0' : '1');
      return !v;
    });
  }, []);
  // View options live here so the header owns the whole toolbar row.
  const [compressed, setCompressed] = useState(true);
  const [showMergeLinks, setShowMergeLinks] = useState(true);
  const [showRefLabels, setShowRefLabels] = useState(true);

  // --- Tab shell state ---
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<number | null>(null);
  // Family snapshots per repo (from each OpenedRepo; refreshed on
  // repo-changed, see refreshFamily below).
  const [families, setFamilies] = useState<Record<number, WorktreeMember[]>>({});
  // Each tab's open-time view: RepoView reads it exactly once, at first
  // mount (initialData seeds its gitData state).
  const [openData, setOpenData] = useState<Record<number, GitData>>({});
  // Open-path failures surface here (restore member gone, picker picked a
  // non-repo, ...): a raw backend-message strip above the tab bar, cleared
  // by the next successful open. i18n keys land in Task 6.
  const [openError, setOpenError] = useState<string | null>(null);

  // Async handlers read the shell state through these refs (updated by
  // applyTabs, the single writer) instead of stale closures.
  const tabsRef = useRef<TabInfo[]>([]);
  const activeRepoIdRef = useRef<number | null>(null);
  // The include-stale policy for new opens; App reads it from settings but
  // openTab must never capture a stale render's value.
  const staleRef = useRef(showStaleBranches);
  useEffect(() => { staleRef.current = showStaleBranches; }, [showStaleBranches]);
  // Last activated repo per commondir: clicking a group's first-level tab
  // returns to the member the user was last on (not always the group's
  // first-opened representative).
  const lastActiveInGroup = useRef<Map<string, number>>(new Map());
  // Per-repo debounce timers for the family refresh listener below.
  const familyTimers = useRef<Map<number, number>>(new Map());

  // Single writer for the tab shell: applies the next tabs/active pair,
  // mirrors both into the refs, records the group's last-active member,
  // and persists. The persisted active index is DERIVED from the active
  // repo id, so a close can never leave a dangling index behind.
  const applyTabs = useCallback((nextTabs: TabInfo[], nextActiveRepoId: number | null) => {
    tabsRef.current = nextTabs;
    activeRepoIdRef.current = nextActiveRepoId;
    setTabs(nextTabs);
    setActiveRepoId(nextActiveRepoId);
    if (nextActiveRepoId != null) {
      const active = nextTabs.find(tb => tb.repoId === nextActiveRepoId);
      if (active) lastActiveInGroup.current.set(active.commondir, active.repoId);
    }
    persistTabs(nextTabs, nextTabs.findIndex(tb => tb.repoId === nextActiveRepoId));
  }, []);

  // Integrate one OpenedRepo -- the shared tail of every open source: a
  // dedup hit (backend matched the canonical path to an open session)
  // activates the existing tab; a fresh id pushes a new tab. The backend
  // already made the opened repo the active one.
  const integrateOpened = useCallback((opened: OpenedRepo, path: string) => {
    setFamilies(prev => ({ ...prev, [opened.repo_id]: opened.family }));
    setOpenData(prev =>
      opened.repo_id in prev ? prev : { ...prev, [opened.repo_id]: opened.data });
    setOpenError(null);
    const existing = tabsRef.current.findIndex(tb => tb.repoId === opened.repo_id);
    if (existing >= 0) {
      applyTabs(tabsRef.current, opened.repo_id);
      return;
    }
    applyTabs(
      [...tabsRef.current, { repoId: opened.repo_id, path, commondir: opened.commondir }],
      opened.repo_id,
    );
  }, [applyTabs]);

  // THE open entry (spec 5.2): every path-based source funnels here --
  // picker, restore, second-level lazy chip, and Task 6's drag-drop. The
  // frontend never compares paths itself; dedup is the backend's call.
  const openTab = useCallback(async (path: string) => {
    try {
      const opened = await openRepository(path, staleRef.current);
      integrateOpened(opened, path);
    } catch (err) {
      recordFrontendError(errText(err));
      setOpenError(errText(err));
    }
  }, [integrateOpened]);

  // Picker: the dialog part of the old selectAndOpenRepository flow, run
  // here so the picked path goes through the same openTab as everything
  // else (api.ts keeps the one-shot wrapper as contract surface).
  const openPicker = useCallback(async () => {
    let selected: unknown = null;
    try {
      selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select Git Repository',
      });
    } catch {
      return;
    }
    if (selected && typeof selected === 'string') await openTab(selected);
  }, [openTab]);

  // Close one tab: the backend removes the session (killing that tab's
  // terminal, Task 2) and the neighbor rule picks the next active tab --
  // but ONLY when the closed tab is the active one; closing a background
  // tab (group x) keeps the current view (nextActiveRepoId, Fix-2 I2).
  // The next-active repo id resolves against the PRE-close list (ids,
  // unlike indices, survive the close). The per-repo family/open-data
  // entries go with the tab (a re-open of the same path gets a fresh
  // repo_id and repopulates them).
  const closeTab = useCallback((repoId: number) => {
    const idx = tabsRef.current.findIndex(tb => tb.repoId === repoId);
    if (idx < 0) return;
    void closeRepository(repoId).catch(err => {
      recordFrontendError(errText(err));
    });
    const nextRepoId = nextActiveRepoId(tabsRef.current, activeRepoIdRef.current, repoId);
    // Fix-2 I1: the backend `active` is the auto-fetch target, and
    // close_repository zeroes it when the closed tab was the active one --
    // without this re-assert the fetcher idles on NoTarget until the next
    // manual tab click. Racing closeRepository is harmless in both orders:
    // a background close re-asserts the unchanged value; an active close
    // converges on the neighbor either way.
    if (nextRepoId != null) {
      void setActiveRepository(nextRepoId).catch(() => {});
    }
    setFamilies(prev => {
      if (!(repoId in prev)) return prev;
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
    setOpenData(prev => {
      if (!(repoId in prev)) return prev;
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
    applyTabs(
      tabsRef.current.filter(tb => tb.repoId !== repoId),
      nextRepoId,
    );
  }, [applyTabs]);

  // Plain tab switch (no open involved): tell the backend too -- `active`
  // is the auto-fetch target.
  const activateTab = useCallback((repoId: number) => {
    if (!tabsRef.current.some(tb => tb.repoId === repoId)) return;
    applyTabs(tabsRef.current, repoId);
    void setActiveRepository(repoId).catch(() => {});
  }, [applyTabs]);

  // First-level tabs are commondir groups: clicking one returns to the
  // member last active in that group (fallback: first-opened member).
  const activateGroup = useCallback((group: TabInfo[]) => {
    const preferred = lastActiveInGroup.current.get(group[0].commondir);
    const target = preferred != null && group.some(tb => tb.repoId === preferred)
      ? preferred
      : group[0].repoId;
    activateTab(target);
  }, [activateTab]);

  // The x on a first-level tab closes the whole family group (each member
  // loses its session and its terminal; the neighbor rule runs per close).
  const closeGroup = useCallback((group: TabInfo[]) => {
    for (const tb of group) closeTab(tb.repoId);
  }, [closeTab]);

  // Family refresh on repo-changed (Task 5 choice): the payload carries
  // no family snapshot, so App re-opens the changed repo's path --
  // already_open semantics return the freshly re-enumerated family plus
  // the existing view (discarded) at the cost of one canonicalize +
  // enumerate per burst, debounced like RepoView's own refresh. App does
  // NOT sync families when RepoView refreshes its data: openTab and this
  // listener are the only family sources.
  const refreshFamily = useCallback(async (repoId: number) => {
    const tab = tabsRef.current.find(tb => tb.repoId === repoId);
    if (!tab) return;
    try {
      const opened = await openRepository(tab.path, staleRef.current);
      // The tab may have closed while this refresh was in flight: a FRESH
      // id here means the backend re-registered the repo after the close
      // (its dedup found nothing) -- undo it rather than leak a session no
      // tab owns.
      if (!tabsRef.current.some(tb => tb.repoId === opened.repo_id) && !opened.already_open) {
        void closeRepository(opened.repo_id).catch(() => {});
        return;
      }
      setFamilies(prev => ({ ...prev, [opened.repo_id]: opened.family }));
      // open_repository re-activates the refreshed repo as a side effect;
      // the fetch target must stay on the tab the user is actually on.
      const activeId = activeRepoIdRef.current;
      if (activeId != null && activeId !== opened.repo_id) {
        void setActiveRepository(activeId).catch(() => {});
      }
    } catch (err) {
      recordFrontendError(errText(err));
    }
  }, []);

  // Cmd+T opens the picker; Cmd+W closes the ACTIVE TAB. On Windows/Linux
  // the keydown reaches the page and preventDefault is enough. On macOS the
  // native menu (rebuilt in lib.rs, Fix-1) owns Cmd+W: NSMenu key
  // equivalents fire BEFORE the webview sees the key, so this handler never
  // runs there and the menu's "close-active-tab" emit (listener below) is
  // the only path -- the two can never double-fire. The original Task 5
  // report's claim that this preventDefault "takes over" Cmd+W on macOS was
  // false: it is dead code on that platform.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        void openPicker();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        if (activeRepoIdRef.current != null) closeTab(activeRepoIdRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPicker, closeTab]);

  // macOS menu path for Cmd+W (Fix-1): the custom File > Close Tab item in
  // the rebuilt native menu (lib.rs) emits "close-active-tab" on the main
  // window instead of performClose: killing the whole window. Same shape as
  // the repo-changed listener: try/catch for the browser mock preview (no
  // event API there until Task 7's stubs land).
  useEffect(() => {
    let dead = false;
    let un: (() => void) | null = null;
    try {
      listen('close-active-tab', () => {
        const id = activeRepoIdRef.current;
        if (id != null) closeTab(id);
      })
        .then(fn => {
          if (dead) fn();
          else un = fn;
        })
        .catch(() => {});
    } catch {
      // browser mock preview: no event API
    }
    return () => {
      dead = true;
      un?.();
    };
  }, [closeTab]);

  // The repo-changed listener feeding refreshFamily. Per-repo timers, one
  // burst per repo id; try/catch for the browser mock preview (no event
  // API there until Task 7's stubs land).
  useEffect(() => {
    let dead = false;
    let un: (() => void) | null = null;
    try {
      listen<RepoChanged>('repo-changed', (e) => {
        const repoId = e.payload?.repo_id;
        if (repoId == null) return;
        const timers = familyTimers.current;
        const prev = timers.get(repoId);
        if (prev !== undefined) window.clearTimeout(prev);
        timers.set(repoId, window.setTimeout(() => {
          if (!dead) void refreshFamily(repoId);
        }, 500));
      })
        .then(fn => {
          if (dead) fn();
          else un = fn;
        })
        .catch(() => {});
    } catch {
      // browser mock preview: no event API
    }
    return () => {
      dead = true;
      un?.();
      for (const timer of familyTimers.current.values()) window.clearTimeout(timer);
      familyTimers.current.clear();
    };
  }, [refreshFamily]);

  // Restore (spec 5.4): open every remembered path in order through the
  // same openTab entry (repo ids are runtime-only -- restore re-opens by
  // path), then activate the recorded tab clamped to the last opened.
  // Failing members stop only themselves (openTab records the error; the
  // shell shows the strip). gtv_latest_repo retires here: migrateRestore
  // consumed it on first read.
  useEffect(() => {
    let cancelled = false;
    const restored = migrateRestore();
    if (!restored) return;
    void (async () => {
      for (const path of restored.paths) {
        if (cancelled) return;
        await openTab(path);
      }
      if (cancelled) return;
      const current = tabsRef.current;
      if (current.length === 0) return;
      const idx = Math.min(restored.activeIdx, current.length - 1);
      applyTabs(current, current[idx].repoId);
      // Fix-2 I1: the restore loop's LAST open left the backend `active`
      // (the fetch target) on the last-opened repo while the UI activates
      // the recorded tab -- point the backend at what the user actually
      // had active, or the fetcher polls the wrong repo until the first
      // manual tab click.
      void setActiveRepository(current[idx].repoId).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [openTab, applyTabs]);

  // --- Derived render state ---
  const activeTab = tabs.find(tb => tb.repoId === activeRepoId) ?? null;
  const groups = useMemo(() => groupTabsByCommondir(tabs), [tabs]);
  const activeFamily = activeTab ? families[activeTab.repoId] ?? [] : [];
  const openPaths = useMemo(() => new Set(tabs.map(tb => tb.path)), [tabs]);

  // First-level tab title (spec 5.1): the family's MAIN directory name
  // (stable no matter which member opened first); the representative
  // tab's family snapshot is the metadata source, its path the fallback.
  const groupTitle = (group: TabInfo[]): string => {
    const family = families[group[0].repoId] ?? [];
    const main = family.find(m => m.is_main);
    return main?.name || group[0].path.split('/').pop() || '';
  };

  return (
    <div className="app">
      {/* SettingsDialog stays BEFORE the repo bodies: it shares the z-80
          backdrop class with Checkout/IssueReport, and at equal z the
          paint order is DOM order -- the pre-extraction App rendered it
          first, so a Cmd+, pressed while another modal is open leaves
          that modal on top (first click closes it). Rendered after the
          bodies, the same keypress would flip the stacking instead. */}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {tabs.length > 0 && (
        <div className="tabbar">
          {groups.map(group => {
            const isActiveGroup = activeTab != null
              && group.some(tb => tb.repoId === activeTab.repoId);
            return (
              <div
                key={group[0].commondir}
                className={`tab${isActiveGroup ? ' active' : ''}`}
              >
                <button
                  className="tab-label"
                  title={group[0].path}
                  onClick={() => activateGroup(group)}
                >
                  {groupTitle(group)}
                </button>
                <button
                  className="tab-close"
                  aria-label="close tab"
                  title={group[0].path}
                  onClick={() => closeGroup(group)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            className="tab-new"
            title={t('openRepo')}
            onClick={() => void openPicker()}
          >
            +
          </button>
        </div>
      )}

      {/* Second-level worktree row (spec 5.1): members of the ACTIVE
          family; already-open members are highlighted and clicking them
          just activates (openTab dedup), unopened ones open lazily with a
          fresh repo_id (same-family members never dedup, T1 semantics).
          Hidden entirely for single-worktree families. */}
      {activeFamily.length > 1 && (
        <div className="worktree-row">
          {activeFamily.map(m => {
            const open = openPaths.has(m.path);
            const current = activeTab != null && m.path === activeTab.path;
            return (
              <button
                key={m.path}
                className={`wt-chip${open ? ' open' : ''}${current ? ' current' : ''}`}
                title={m.path}
                onClick={() => void openTab(m.path)}
              >
                {m.is_main ? '• ' : ''}{m.name}
              </button>
            );
          })}
        </div>
      )}

      {openError && (
        <div className="error">
          <span className="error-msg">{openError}</span>
        </div>
      )}

      {tabs.length === 0 ? (
        <main className="main">
          <div className="welcome">
            <h2>{t('welcomeTitle')}</h2>
            <p>{t('welcomeSubtitle')}</p>
            <p className="hint">{t('welcomeHint')}</p>
            <button className="open-btn" onClick={() => void openPicker()}>
              {t('openRepo')}
            </button>
          </div>
        </main>
      ) : (
        tabs.map(tab => (
          <div
            key={tab.repoId}
            className={tab.repoId === activeRepoId ? 'tab-body' : 'tab-body tab-body-hidden'}
          >
            <RepoView
              repoId={tab.repoId}
              path={tab.path}
              initialData={openData[tab.repoId]}
              active={tab.repoId === activeRepoId}
              onOpenPicker={() => void openPicker()}
              showTags={showTags}
              toggleShowTags={toggleShowTags}
              compressed={compressed}
              setCompressed={setCompressed}
              showMergeLinks={showMergeLinks}
              setShowMergeLinks={setShowMergeLinks}
              showRefLabels={showRefLabels}
              setShowRefLabels={setShowRefLabels}
              showIssueReport={showIssueReport}
              setShowIssueReport={setShowIssueReport}
              setShowSettings={setShowSettings}
            />
          </div>
        ))
      )}
    </div>
  );
}

export default App;
