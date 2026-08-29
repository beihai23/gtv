/** Bottom-terminal panel height: clamp + persistence (localStorage key
 *  `gtv_term_height`, same convention as gtv_lang / gtv_theme). */

export const TERM_MIN_HEIGHT = 120;
export const DEFAULT_TERM_HEIGHT = 260;

const HEIGHT_KEY = 'gtv_term_height';

/** Clamp a candidate panel height into [TERM_MIN_HEIGHT, 60% of the
 *  viewport]. Non-finite input falls back to the default. */
export function clampTerminalHeight(height: number, viewportHeight: number): number {
  const max = Math.max(TERM_MIN_HEIGHT, Math.floor(viewportHeight * 0.6));
  const value = Number.isFinite(height) ? height : DEFAULT_TERM_HEIGHT;
  return Math.min(max, Math.max(TERM_MIN_HEIGHT, Math.round(value)));
}

export function loadTermHeight(viewportHeight: number): number {
  const raw = parseInt(localStorage.getItem(HEIGHT_KEY) ?? '', 10);
  return clampTerminalHeight(Number.isFinite(raw) ? raw : DEFAULT_TERM_HEIGHT, viewportHeight);
}

export function saveTermHeight(height: number): void {
  localStorage.setItem(HEIGHT_KEY, String(height));
}
