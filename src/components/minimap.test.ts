import { describe, expect, it } from 'vitest';
import { minimapMap, viewportRect } from './minimap';

// Pure-function tests for the scene->minimap mapping (final-review F2
// regression pin plus sanity anchors). The F2 trigger is constructed from
// the REAL repro, not a synthetic constant: a keep-alive Timeline hidden
// via display:none while the window is resized measures clientWidth 0, so
// Timeline.tsx's minimapViewport calls viewportRect with windowW = 0 while
// the map still describes the (previously laid out) scene.

describe('viewportRect zero-window guard (F2)', () => {
  // The map a hidden Timeline still holds: fitted against the scene it saw
  // before display:none zeroed the container.
  const m = minimapMap(3000, 400, 180, 60, -180, -40);

  it('returns a finite zero rect for a hidden container (windowW = 0)', () => {
    const r = viewportRect(1, 0, 0, 0, 800, m);
    // Pre-guard this was x/y/w/h all NaN (f = 6/0 = Infinity -> 0*Inf).
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(Number.isFinite(r.w)).toBe(true);
    expect(Number.isFinite(r.h)).toBe(true);
    expect(r).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('returns a finite zero rect for windowH = 0 too', () => {
    const r = viewportRect(2, 100, 50, 1200, 0, m);
    expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
    expect(r).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('viewportRect sanity anchors', () => {
  const m = minimapMap(3000, 400, 180, 60, -180, -40);

  it('keeps the window aspect ratio at normal sizes (uniform scale)', () => {
    const r = viewportRect(1, 0, 0, 1200, 800, m);
    expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
    expect(r.w / r.h).toBeCloseTo(1200 / 800, 10);
  });

  it('still applies the visibility floor at extreme zoom (min side >= 6)', () => {
    // Zoomed so far in that the raw rect shrinks below the 6px floor.
    const r = viewportRect(40, 0, 0, 1200, 800, m);
    expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(6 - 1e-9);
    // Grown around its own center: the aspect ratio survives the floor.
    expect(r.w / r.h).toBeCloseTo(1200 / 800, 10);
  });
});
