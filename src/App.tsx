import { useState, useCallback, useEffect, useRef } from 'react';
import './App.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsDialog } from './components/SettingsDialog';
import RepoView from './RepoView';
import {
  openRepository,
  closeRepository,
  setActiveRepository,
  setAutoFetch,
  listWorktreeMembers,
} from './api';
import {
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
  const { t, showStaleBranches, autoFetch } = useSettings();
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
  // non-repo, dragged a plain file, ...): a strip above the tab bar with
  // the raw backend message and a retry button, cleared by the next
  // successful open.
  const [openError, setOpenError] = useState<string | null>(null);
  // The failed path behind openError (retry target); null while the error
  // is clear.
  const [openErrorPath, setOpenErrorPath] = useState<string | null>(null);
  // True while a native drag hovers the window (drag-drop opening): drives
  // the full-window .drag-overlay.
  const [dragOver, setDragOver] = useState(false);

  // Async handlers read the shell state through these refs (updated by
  // applyTabs, the single writer) instead of stale closures.
  const tabsRef = useRef<TabInfo[]>([]);
  const activeRepoIdRef = useRef<number | null>(null);
  // The include-stale policy for new opens; App reads it from settings but
  // openTab must never capture a stale render's value.
  const staleRef = useRef(showStaleBranches);
  useEffect(() => { staleRef.current = showStaleBranches; }, [showStaleBranches]);
  // Per-repo debounce timers for the family refresh listener below.
  const familyTimers = useRef<Map<number, number>>(new Map());

  // Single writer for the tab shell: applies the next tabs/active pair,
  // mirrors both into the refs, and persists. The persisted active index
  // is DERIVED from the active repo id, so a close can never leave a
  // dangling index behind.
  const applyTabs = useCallback((nextTabs: TabInfo[], nextActiveRepoId: number | null) => {
    tabsRef.current = nextTabs;
    activeRepoIdRef.current = nextActiveRepoId;
    setTabs(nextTabs);
    setActiveRepoId(nextActiveRepoId);
    persistTabs(nextTabs, nextTabs.findIndex(tb => tb.repoId === nextActiveRepoId));
  }, []);

  // Integrate one OpenedRepo -- the shared tail of every open source: a
  // dedup hit (backend matched the canonical path to an open session)
  // activates the existing tab; a path from an ALREADY-OPEN worktree
  // family switches that family's tab to the new member (one tab per
  // family -- members are anchor parameters of one view, not separate
  // views); anything else pushes a fresh tab. The backend already made
  // the opened repo the active one.
  const integrateOpened = useCallback((opened: OpenedRepo, path: string) => {
    setOpenError(null);
    setOpenErrorPath(null);
    const familySnapshot = () => setFamilies(prev =>
      ({ ...prev, [opened.repo_id]: opened.family }));
    const seedData = () => setOpenData(prev =>
      opened.repo_id in prev ? prev : { ...prev, [opened.repo_id]: opened.data });
    const existing = tabsRef.current.findIndex(tb => tb.repoId === opened.repo_id);
    if (existing >= 0) {
      familySnapshot();
      seedData();
      applyTabs(tabsRef.current, opened.repo_id);
      return;
    }
    // Member switch: re-point the family's tab at the newly opened
    // member IN PLACE (same tab slot) and retire the old member's
    // session -- its watcher, terminal and repo id go with it.
    const familyIdx = tabsRef.current.findIndex(tb => tb.commondir === opened.commondir);
    if (familyIdx >= 0) {
      const old = tabsRef.current[familyIdx];
      void closeRepository(old.repoId).catch(() => {});
      setFamilies(prev => {
        const next = { ...prev };
        delete next[old.repoId];
        return { ...next, [opened.repo_id]: opened.family };
      });
      setOpenData(prev => {
        const next = { ...prev };
        delete next[old.repoId];
        return { ...next, [opened.repo_id]: opened.data };
      });
      applyTabs(
        tabsRef.current.map((tb, i) =>
          i === familyIdx ? { repoId: opened.repo_id, path, commondir: opened.commondir } : tb),
        opened.repo_id,
      );
      return;
    }
    familySnapshot();
    seedData();
    applyTabs(
      [...tabsRef.current, { repoId: opened.repo_id, path, commondir: opened.commondir }],
      opened.repo_id,
    );
  }, [applyTabs]);

  // THE open entry (spec 5.2): every path-based source funnels here --
  // picker, restore, second-level lazy chip, and drag-drop. The frontend
  // never compares paths itself; dedup is the backend's call.
  const openTab = useCallback(async (path: string) => {
    try {
      const opened = await openRepository(path, staleRef.current);
      integrateOpened(opened, path);
    } catch (err) {
      recordFrontendError(errText(err));
      setOpenError(errText(err));
      setOpenErrorPath(path);
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
    // Cancel this repo's pending family-refresh debounce (final-review L5):
    // a repo-changed burst shortly before the close leaves a 500ms timer
    // armed; if it fires after a close+reopen of the same path, its
    // refreshFamily rollback ("a fresh id no tab owns") would close the
    // user's just-reopened tab.
    const pending = familyTimers.current.get(repoId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      familyTimers.current.delete(repoId);
    }
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

  // Family refresh (Task 5 choice, simplified): one pure re-enumeration
  // command instead of the old re-open path -- re-opening had to undo
  // open_repository's activation side effect and guard against a leaked
  // re-registered session, all to obtain a snapshot the command now
  // returns directly. Two callers: the debounced repo-changed listener,
  // and the member menu, which re-enumerates on every open because
  // members other than the watched one can be added or removed
  // externally at any time (a removed member must drop out of the list,
  // not sit there erroring on click). App does NOT sync families when
  // RepoView refreshes its data: openTab and this callback are the only
  // family sources.
  const refreshFamily = useCallback(async (repoId: number) => {
    if (!tabsRef.current.some(tb => tb.repoId === repoId)) return;
    try {
      const family = await listWorktreeMembers(repoId);
      // Tab may have closed while the call was in flight -- write only
      // into an existing entry so a closed tab's key is not resurrected.
      setFamilies(prev => (prev[repoId] ? { ...prev, [repoId]: family } : prev));
    } catch {
      // Best effort: the menus keep the last known list on failure.
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

  // Auto-fetch sync (spec 4.3). The backend AppState defaults auto_fetch
  // to TRUE (commands.rs), so this effect's startup job is the OFF
  // direction: a user who disabled auto-fetch must not be silently
  // re-enabled on relaunch. It also propagates setting changes (the 60s
  // thread picks the new value up on its next tick, T3 semantics).
  // Silent catch: the browser mock has no backend to sync.
  useEffect(() => {
    void setAutoFetch(autoFetch).catch(() => {});
  }, [autoFetch]);

  // Drag-drop opening (spec 5.2 third entrance): a native drag over the
  // window highlights everything via .drag-overlay; dropping opens each
  // path sequentially through the same openTab funnel (dedup and the error
  // strip are openTab's job -- a dropped non-repo file lands in the
  // repoOpenFailed strip, it cannot crash anything). tauri.conf.json leaves
  // dragDropEnabled at its default (true), so the webview intercepts HTML5
  // drag events and only this API sees native drags. try/catch for the
  // browser mock preview (no webview API there until Task 7's stubs land).
  useEffect(() => {
    let dead = false;
    let un: (() => void) | null = null;
    try {
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'enter' || p.type === 'over') {
          setDragOver(true);
        } else if (p.type === 'leave') {
          setDragOver(false);
        } else if (p.type === 'drop') {
          setDragOver(false);
          void (async () => {
            for (const path of p.paths) {
              await openTab(path);
            }
          })();
        }
      })
        .then(fn => {
          if (dead) fn();
          else un = fn;
        })
        .catch(() => {});
    } catch {
      // browser mock preview: no webview API
    }
    return () => {
      dead = true;
      un?.();
    };
  }, [openTab]);

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

  // Tab title: the family's MAIN directory name (stable no matter which
  // member is currently selected); the tab's family snapshot is the
  // metadata source, its path the fallback.
  const tabTitle = (tab: TabInfo): string => {
    const family = families[tab.repoId] ?? [];
    const main = family.find(m => m.is_main);
    return main?.name || tab.path.split('/').pop() || '';
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

      {/* Global chrome band: always rendered, even with zero tabs.
          Shell-level controls live here rather than inside a tab --
          and with no tabs open there was previously no way to reach
          settings by mouse at all (Cmd+, was the only entry left).
          The tabbar fills the remaining width; the gear is pinned
          right, outside its horizontal scroll. */}
      <div className="topbar">
      {tabs.length > 0 && (
        <div className="tabbar">
          {tabs.map(tab => (
            <div
              key={tab.commondir}
              className={`tab${tab.repoId === activeRepoId ? ' active' : ''}`}
            >
              <button
                className="tab-label"
                title={tab.path}
                onClick={() => activateTab(tab.repoId)}
              >
                {tabTitle(tab)}
              </button>
              <button
                className="tab-close"
                aria-label={t('closeTab')}
                title={t('closeTab')}
                onClick={() => closeTab(tab.repoId)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="tab-new"
            title={t('openRepo')}
            onClick={() => void openPicker()}
          >
            +
          </button>
        </div>
      )}
      <button
        className="view-btn settings-btn"
        onClick={() => setShowSettings(true)}
        title={`${t('settings')} (⌘,)`}
      >
        ⚙
      </button>
      </div>

      {/* Open failure strip: the i18n lead-in plus the RAW backend message
          (kept untranslated -- it is the actual error contract), a retry
          button that re-runs openTab on the failed path, and a dismiss x
          (T6 L3': before it the strip could only be displaced by the next
          successful open). */}
      {openError && (
        <div className="error">
          <span className="error-msg">{t('repoOpenFailed')}: {openError}</span>
          {openErrorPath && (
            <button
              className="error-report-btn"
              onClick={() => void openTab(openErrorPath)}
            >
              {t('retry')}
            </button>
          )}
          <button
            className="error-dismiss"
            aria-label={t('close')}
            title={t('close')}
            onClick={() => {
              setOpenError(null);
              setOpenErrorPath(null);
            }}
          >
            ×
          </button>
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
            <p className="hint">{t('welcomeDropHint')}</p>
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
              family={families[tab.repoId] ?? []}
              onSwitchMember={openTab}
              onRefreshFamily={refreshFamily}
              active={tab.repoId === activeRepoId}
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
            />
          </div>
        ))
      )}

      {/* Full-window drop affordance while a native drag hovers: translucent
          veil, dashed accent frame, and the release hint. pointer-events
          stay off -- the native drop must reach the webview, not this
          layer. */}
      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-frame" />
          <div className="drag-overlay-msg">{t('dropToOpen')}</div>
        </div>
      )}
    </div>
  );
}

export default App;
