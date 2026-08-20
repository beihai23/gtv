/**
 * Pure scene→minimap mapping. Zero dependencies so it can be unit-tested and
 * reused by both the minimap draw pass and the viewport-rect / jump-hit paths
 * (both directions derive from the same map, which keeps them exact inverses).
 */

/** Scene→minimap map: one uniform scale plus a translation. mini = (scene - x0) * s */
export interface MinimapMap {
  /** Uniform scale for both axes. */
  s: number;
  /** Scene x that maps to minimap x = 0 (scene minX minus the letterbox offset, in scene units). */
  x0: number;
  /** Scene y that maps to minimap y = 0. */
  y0: number;
}

/**
 * Fit the scene into the box with a single scale factor and center it on both
 * axes (letterbox). The scene fills the constrained axis and keeps its aspect
 * ratio on the free one — no per-axis stretching.
 */
export function minimapMap(sceneW: number, sceneH: number, boxW: number, boxH: number, minX: number, minY: number): MinimapMap {
  const w = Math.max(sceneW, 1);
  const h = Math.max(sceneH, 1);
  const s = Math.min(boxW / w, boxH / h);
  // Letterbox gaps live in box pixels; convert to scene units before folding
  // them into x0/y0 so mini = (scene - x0) * s holds everywhere.
  return {
    s,
    x0: minX - (boxW - w * s) / (2 * s),
    y0: minY - (boxH - h * s) / (2 * s),
  };
}

/**
 * Rectangle on the minimap covered by the timeline window, in minimap
 * coordinates. screen = t * scene, so the window is the scene rect
 * [-tx/k, -tx/k + windowW/k] × [-ty/k, -ty/k + windowH/k] pushed through the
 * minimap map. Its aspect ratio is exactly windowW/windowH because the map
 * uses one uniform scale — the property the per-axis map broke.
 */
export function viewportRect(k: number, tx: number, ty: number, windowW: number, windowH: number, m: MinimapMap): { x: number; y: number; w: number; h: number } {
  const vw = (windowW / k) * m.s;
  const vh = (windowH / k) * m.s;
  const x = (-tx / k - m.x0) * m.s;
  const y = (-ty / k - m.y0) * m.s;
  // Visibility floor: at extreme zoom the raw rect can shrink to sub-pixels.
  // Scale both sides by the same factor so the aspect ratio survives, and
  // grow the rectangle around its own center so it stays where the window is.
  const f = 6 / Math.min(vw, vh);
  if (f <= 1) return { x, y, w: vw, h: vh };
  const w = vw * f;
  const h = vh * f;
  return { x: x - (w - vw) / 2, y: y - (h - vh) / 2, w, h };
}
