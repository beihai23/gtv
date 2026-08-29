import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
// Without the stylesheet xterm renders as unstyled garbled markup.
import '@xterm/xterm/css/xterm.css';
import { ptySpawn, ptyWrite, ptyResize, ptyClose, onPtyOutput, onPtyExit } from '../api';
import { shouldToggleTerminal, normalizeSessionId } from '../terminalCore';
import { useSettings, cssVar } from '../settings';

// xterm.js cannot read CSS variables, so the panel theme is materialized
// from the :root palette at boot and again whenever the preset changes.
function terminalTheme(): ITheme {
  return {
    background: cssVar('--bg-panel', '#16213e'),
    foreground: cssVar('--text', '#e0e0e0'),
    cursor: cssVar('--accent', '#e94560'),
    cursorAccent: cssVar('--bg-panel', '#16213e'),
    selectionBackground: `rgba(${cssVar('--link-rgb', '74, 144, 217')}, 0.35)`,
  };
}

const MONO_STACK = "'SF Mono', 'Cascadia Code', Consolas, Menlo, monospace";

interface TerminalPanelProps {
  repoPath: string;
  open: boolean;
  onToggle: () => void;
}

/**
 * Bottom-embedded terminal (Ctrl+`): a real PTY shell with cwd at the open
 * repository root. The component stays mounted while collapsed — only CSS
 * folds it away — so the shell session and scrollback survive
 * collapse/expand. Teardown (ptyClose + dispose) happens exclusively on
 * repo switch or unmount; every effect cleanup is idempotent to survive
 * React.StrictMode's dev double-mount.
 */
export function TerminalPanel({ repoPath, open, onToggle }: TerminalPanelProps) {
  const { t, theme } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  // Bumped on every teardown so late-arriving spawn results from a previous
  // session (rapid repo switch) can be recognized and closed.
  const epochRef = useRef(0);
  const [exited, setExited] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const spawnSession = useCallback((term: Terminal) => {
    const epoch = epochRef.current;
    ptySpawn(term.cols, term.rows)
      .then(v => {
        const id = normalizeSessionId(v);
        if (epoch !== epochRef.current) {
          // Session torn down while spawning — close the orphan if any.
          if (id !== null) ptyClose(id).catch(() => {});
          return;
        }
        if (id === null) {
          // Browser mock / no backend: unknown invokes resolve null.
          setUnavailable(true);
          return;
        }
        idRef.current = id;
        setUnavailable(false);
        setSpawnError(null);
        setExited(false);
        term.focus();
      })
      .catch(err => {
        if (epoch === epochRef.current) {
          setSpawnError(err instanceof Error ? err.message : String(err));
        }
      });
  }, []);

  const teardown = useCallback(() => {
    epochRef.current += 1;
    const id = idRef.current;
    if (id !== null) ptyClose(id).catch(() => {});
    idRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  // Lifecycle: the session is torn down ONLY here — unmount or repo switch.
  // Toggling `open` never runs this cleanup, which is what preserves the
  // shell and its scrollback across collapse/expand.
  useEffect(() => {
    return () => teardown();
  }, [repoPath, teardown]);

  // Lazy boot on first open (and again after a repo switch). The backend
  // derives the cwd from AppState.current_path, so the repoPath prop is the
  // re-spawn trigger, not a parameter.
  useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el || termRef.current) return;

    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* container not measurable yet */ }

    // The toggle combo must not be typed into the shell: return false so
    // xterm ignores it and the event bubbles to the App-level listener.
    term.attachCustomKeyEventHandler(e => !shouldToggleTerminal(e));

    term.onData(data => {
      const id = idRef.current;
      if (id !== null) ptyWrite(id, data).catch(() => {});
    });

    spawnSession(term);
  }, [open, repoPath, spawnSession]);

  // Backend events, filtered by session id so a just-restarted or just-
  // switched session never renders a dead session's tail.
  useEffect(() => {
    let unOutput: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let alive = true;
    onPtyOutput(e => {
      const term = termRef.current;
      if (term && e.id === idRef.current) term.write(e.data);
    }).then(un => { if (alive) unOutput = un; else un(); });
    onPtyExit(e => {
      if (e.id === idRef.current) setExited(true);
    }).then(un => { if (alive) unExit = un; else un(); });
    return () => {
      alive = false;
      unOutput?.();
      unExit?.();
    };
  }, []);

  // Window resize / panel resize → re-fit xterm and tell the kernel side.
  // Skipped while collapsed: a zero-size container fits to 0×0.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!open || !term || !fit || el.offsetWidth === 0) return;
      try { fit.fit(); } catch { /* mid-layout, next tick retries */ }
      const id = idRef.current;
      if (id !== null) ptyResize(id, term.cols, term.rows).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  // Expand: re-fit after the height transition has a frame to lay out, then
  // hand focus to the shell so typing works immediately.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        try { fit.fit(); } catch { /* not measurable */ }
        const id = idRef.current;
        if (id !== null) ptyResize(id, term.cols, term.rows).catch(() => {});
      }
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Theme preset switch → repaint the terminal (xterm ignores CSS vars).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme();
  }, [theme]);

  // Restart after the shell exited: same terminal surface, fresh session.
  const handleRestart = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const id = idRef.current;
    if (id !== null) ptyClose(id).catch(() => {});
    idRef.current = null;
    setExited(false);
    term.reset();
    spawnSession(term);
  }, [spawnSession]);

  return (
    <div className={`terminal-panel ${open ? 'open' : ''}`}>
      <div className="terminal-header">
        <span className="terminal-title">{t('terminal')}</span>
        {exited && <span className="terminal-status">{t('terminalExited')}</span>}
        {spawnError && <span className="terminal-status" title={spawnError}>{spawnError}</span>}
        {exited && (
          <button className="terminal-restart" onClick={handleRestart}>
            {t('terminalRestart')}
          </button>
        )}
        <button className="terminal-collapse" onClick={onToggle} title="Ctrl+`">⌄</button>
      </div>
      <div className="terminal-body" ref={containerRef}>
        {unavailable && (
          <div className="terminal-unavailable">{t('terminalUnavailable')}</div>
        )}
      </div>
    </div>
  );
}
