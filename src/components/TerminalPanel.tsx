import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { recordFrontendError } from '../issueContext';
import { terminalKill, terminalResize, terminalSpawn, terminalWrite } from '../api';
import { cssVar, useSettings } from '../settings';
import { clampTerminalHeight, loadTermHeight, saveTermHeight } from '../terminalSize';
import type { TerminalExit, TerminalOutput } from '../types';

interface Props {
  /** Which open repository's session this panel drives (Task 5: terminal
   *  commands are repo_id-routed; one PTY per tab). */
  repoId: number;
  /** Panel visibility. The xterm session stays alive while hidden. */
  open: boolean;
  onClose: () => void;
  /** Flipped once terminalSpawn resolves null (browser mock preview). */
  onUnavailable: () => void;
}

/** Terminal colors follow the preset theme's CSS custom properties. */
function themeFromCssVars() {
  return {
    background: cssVar('--bg-panel', '#16213e'),
    foreground: cssVar('--text', '#e0e0e0'),
    cursor: cssVar('--text', '#e0e0e0'),
    cursorAccent: cssVar('--bg-panel', '#16213e'),
    selectionBackground: cssVar('--bg-input', '#0f3460'),
  };
}

/** Base64 → bytes: PTY chunks are raw and may split UTF-8 sequences, so
 *  they must reach xterm as bytes, never as lossy strings. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export default function TerminalPanel({ repoId, open, onClose, onUnavailable }: Props) {
  const { theme, t } = useSettings();

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Session id of the live PTY; null while (re)spawning. Output/exit events
   *  are filtered on it so a killed session racing its replacement is
   *  dropped instead of corrupting the new one. */
  const sessionIdRef = useRef<number | null>(null);
  const openedRef = useRef(false);
  const exitedRef = useRef(false);

  const [height, setHeight] = useState(() => loadTermHeight(window.innerHeight));
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Create the Terminal once per mount (no term.open yet — that needs a
  // visible container). All subscriptions have real cleanup because React
  // StrictMode double-mounts effects in dev.
  useEffect(() => {
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromCssVars(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Ctrl+` must toggle the panel from inside the terminal too. Returning
    // false skips xterm's own processing (the shell never receives the key)
    // while the raw event still bubbles to App's window listener.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
        return false;
      }
      return true;
    });
    term.onData((data) => {
      void terminalWrite(repoId, data).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      if (sessionIdRef.current !== null) void terminalResize(repoId, cols, rows).catch(() => {});
    });
    termRef.current = term;
    fitRef.current = fit;

    // Subscribe before any spawn can produce output, so the banner/prompt
    // of a fresh shell is never missed. try/catch: the browser mock has no
    // event API.
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const subscribe = <T,>(event: string, handler: (payload: T) => void) => {
      try {
        listen<T>(event, (e) => handler(e.payload))
          .then((un) => {
            if (disposed) un();
            else unlisteners.push(un);
          })
          .catch(() => {});
      } catch {
        // browser mock preview
      }
    };
    subscribe<TerminalOutput>('terminal-output', (payload) => {
      if (payload.id === sessionIdRef.current) term.write(b64ToBytes(payload.data));
    });
    subscribe<TerminalExit>('terminal-exit', (payload) => {
      if (payload.id === sessionIdRef.current) {
        exitedRef.current = true;
        setExited(true);
      }
    });

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: re-read the CSS vars xterm can't see.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFromCssVars();
  }, [theme]);

  const ensureSession = useCallback(
    async (term: Terminal, fit: FitAddon) => {
      // fit() is a silent no-op on a hidden container (NaN dimensions), so
      // this must run while the panel is visible; the PTY is then created
      // at the fitted size instead of 80x24.
      fit.fit();
      try {
        const info = await terminalSpawn(repoId, term.cols, term.rows);
        if (!info) {
          onUnavailable();
          return;
        }
        sessionIdRef.current = info.id;
        setSessionCwd(info.cwd);
        void terminalResize(repoId, term.cols, term.rows).catch(() => {});
      } catch (err) {
        recordFrontendError(`terminal spawn failed: ${err}`);
        return;
      }
      term.focus();
    },
    [repoId, onUnavailable],
  );

  // Visibility sequencing: open the terminal into the (now visible)
  // container, fit, spawn once, focus. Re-opening a hidden-but-alive panel
  // takes the same path — fit re-measures, onResize syncs the PTY, and the
  // scrollback survives.
  useEffect(() => {
    if (!open) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;
    if (!openedRef.current) {
      term.open(container);
      openedRef.current = true;
    }
    const raf = requestAnimationFrame(() => {
      void ensureSession(term, fit);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, ensureSession]);

  // Window resize + drag-resize both land here: one observer, rAF-debounced
  // fitting. Skipped while hidden (width 0 would collapse the grid).
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitRef.current?.fit());
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const handleRestart = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    void terminalKill(repoId).catch(() => {});
    // Drop the id first: the old session's "terminal-exit" event must not
    // flip the new session back into the exited overlay.
    sessionIdRef.current = null;
    exitedRef.current = false;
    setExited(false);
    term.reset();
    await ensureSession(term, fit);
  }, [repoId, ensureSession]);

  // Drag handle: pointer capture, clamped height, persisted on release.
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startHeight: height };
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = clampTerminalHeight(
      dragRef.current.startHeight - (e.clientY - dragRef.current.startY),
      window.innerHeight,
    );
    setHeight(next);
  };
  const onHandlePointerUp = () => {
    if (dragRef.current) {
      dragRef.current = null;
      saveTermHeight(height);
    }
  };

  return (
    <div className={`terminal-panel${open ? '' : ' terminal-panel-hidden'}`} style={{ height }}>
      <div
        className="terminal-resize-handle"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
      />
      <div className="terminal-header">
        <span className="terminal-cwd" title={sessionCwd ?? undefined}>
          {sessionCwd ?? t('terminal')}
        </span>
        <button className="terminal-btn" onClick={() => void handleRestart()} title={t('terminalRestartTip')}>
          ⟳ {t('terminalRestart')}
        </button>
        <button className="close-btn" onClick={onClose} aria-label={t('terminal')}>
          ×
        </button>
      </div>
      <div className="terminal-body" ref={containerRef} />
      {exited && (
        <div className="terminal-exited">
          <span>{t('terminalExited')}</span>
          <button className="terminal-btn" onClick={() => void handleRestart()}>
            {t('terminalRestart')}
          </button>
        </div>
      )}
    </div>
  );
}
