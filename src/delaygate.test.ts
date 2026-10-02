import { describe, it, expect } from 'vitest';
import { createDelayGate, step } from './delaygate';

// drive(): replay a busy timeline [(time, busy), ...] through one gate and
// return the visible flag at each step.
function drive(events: Array<[number, boolean]>, delayMs = 350, minShowMs = 500): boolean[] {
  const gate = createDelayGate(delayMs, minShowMs);
  return events.map(([now, busy]) => step(gate, busy, now).visible);
}

describe('delaygate', () => {
  it('short busy (under delayMs) never shows', () => {
    const gate = createDelayGate();
    expect(step(gate, true, 0)).toEqual({ visible: false, at: 350 });
    // Busy ends before the delay elapses: cancelled outright.
    expect(step(gate, false, 200)).toEqual({ visible: false, at: null });
    // The cancelled wake-up time passes with no busy: still hidden.
    expect(step(gate, false, 400)).toEqual({ visible: false, at: null });
  });

  it('long busy shows exactly at delayMs', () => {
    const gate = createDelayGate();
    expect(step(gate, true, 0).visible).toBe(false);
    expect(step(gate, true, 349).visible).toBe(false);
    const r = step(gate, true, 350);
    expect(r).toEqual({ visible: true, at: null });
    expect(step(gate, true, 1000).visible).toBe(true);
  });

  it('wake-up at the promised `at` time flips to visible', () => {
    const gate = createDelayGate();
    const r = step(gate, true, 100);
    expect(r.at).toBe(450);
    expect(step(gate, true, r.at!).visible).toBe(true);
  });

  it('ending right after show-up pads out to minShowMs', () => {
    const gate = createDelayGate();
    step(gate, true, 0);
    expect(step(gate, true, 350).visible).toBe(true); // shownAt = 350
    // Busy ends at 360 — only 10ms shown, so it must hold until 850.
    const r = step(gate, false, 360);
    expect(r).toEqual({ visible: true, at: 850 });
    expect(step(gate, false, 849).visible).toBe(true);
    expect(step(gate, false, 850)).toEqual({ visible: false, at: null });
  });

  it('busy outlasting delayMs + minShowMs hides immediately on end', () => {
    const gate = createDelayGate();
    step(gate, true, 0);
    step(gate, true, 350);
    expect(step(gate, false, 2000)).toEqual({ visible: false, at: null });
  });

  it('a busy stretch that starts during the pad window re-arms the delay', () => {
    // Visible from 350, busy off at 360 (pad until 850). A NEW busy at 500
    // restarts the delay from 500 — the pad window does not count as busy.
    const gate = createDelayGate();
    step(gate, true, 0);
    step(gate, true, 350);
    step(gate, false, 360);
    expect(step(gate, true, 500)).toEqual({ visible: true, at: null });
    // ...it stays visible because the gate never hid (pad still paying out),
    // and the new busy stretch simply keeps it up.
    expect(step(gate, false, 900)).toEqual({ visible: false, at: null });
  });

  it('rapid on/off jitter below delayMs never flashes', () => {
    const gate = createDelayGate();
    for (let i = 0; i < 20; i++) {
      expect(step(gate, true, i * 200).visible).toBe(false);
      expect(step(gate, false, i * 200 + 100).visible).toBe(false);
    }
    expect(gate.visible).toBe(false);
  });

  it('busy re-asserted during the pad window keeps it visible without re-delay', () => {
    const gate = createDelayGate();
    step(gate, true, 0);
    step(gate, true, 350); // visible, shownAt 350
    step(gate, false, 400); // padding until 850
    // Back to busy at 500 (mid-pad): stays visible, no second delay.
    expect(step(gate, true, 500).visible).toBe(true);
    // And once this stretch ends past minShow, it hides right away.
    expect(step(gate, false, 1000).visible).toBe(false);
  });

  it('drive() reproduces the four scenarios end to end', () => {
    expect(drive([[0, true], [100, false]])).toEqual([false, false]);
    expect(drive([[0, true], [400, true]])).toEqual([false, true]);
    expect(drive([[0, true], [350, true], [360, false], [800, false], [900, false]]))
      .toEqual([false, true, true, true, false]);
    expect(drive([[0, true], [350, true], [1000, false]])).toEqual([false, true, false]);
  });

  it('custom delayMs/minShowMs are honored', () => {
    const gate = createDelayGate(100, 300);
    expect(step(gate, true, 0)).toEqual({ visible: false, at: 100 });
    expect(step(gate, true, 100).visible).toBe(true);
    expect(step(gate, false, 150)).toEqual({ visible: true, at: 400 });
    expect(step(gate, false, 400).visible).toBe(false);
  });
});
