/** Right details-panel width: clamp + persistence (localStorage key
 *  `gtv_details_width`, same convention as gtv_term_height). Shared by the
 *  commit-details and compare panels -- they occupy the same slot. */

export const DETAILS_MIN_WIDTH = 280;
export const DEFAULT_DETAILS_WIDTH = 360;

const WIDTH_KEY = 'gtv_details_width';

/** Clamp a candidate panel width into [DETAILS_MIN_WIDTH, 60% of the
 *  viewport]. Non-finite input falls back to the default. */
export function clampDetailsWidth(width: number, viewportWidth: number): number {
  const max = Math.max(DETAILS_MIN_WIDTH, Math.floor(viewportWidth * 0.6));
  const value = Number.isFinite(width) ? width : DEFAULT_DETAILS_WIDTH;
  return Math.min(max, Math.max(DETAILS_MIN_WIDTH, Math.round(value)));
}

export function loadDetailsWidth(viewportWidth: number): number {
  // Best-effort like persist.ts: a storage-denied webview throws on
  // getItem -- a width preference must never crash the render.
  try {
    const raw = parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10);
    return clampDetailsWidth(Number.isFinite(raw) ? raw : DEFAULT_DETAILS_WIDTH, viewportWidth);
  } catch {
    return clampDetailsWidth(DEFAULT_DETAILS_WIDTH, viewportWidth);
  }
}

export function saveDetailsWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Best-effort, never fatal.
  }
}
