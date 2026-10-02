// Delay gate for busy indicators (Timeline's render badge). Two anti-flicker
// rules:
//   1. Show-up delay: busy must hold for delayMs before the indicator appears,
//      so sub-frame async waits never flash it.
//   2. Minimum show time: once visible it stays at least minShowMs, so a wait
//      ending right after show-up doesn't strobe.
// Pure state machine: step() is driven by the caller's clock (useDelayedBusy
// in Timeline.tsx wraps it with setTimeout), which keeps every transition
// testable without timers.

export interface DelayGate {
  readonly delayMs: number;
  readonly minShowMs: number;
  /** When the current busy stretch started; null while idle. */
  busySince: number | null;
  /** When the indicator became visible; null while hidden. */
  shownAt: number | null;
  visible: boolean;
}

export interface GateStep {
  visible: boolean;
  /** Next moment a timer must wake and re-step; null = no timer needed. */
  at: number | null;
}

export function createDelayGate(delayMs = 350, minShowMs = 500): DelayGate {
  return { delayMs, minShowMs, busySince: null, shownAt: null, visible: false };
}

export function step(gate: DelayGate, busy: boolean, now: number): GateStep {
  if (busy) {
    if (gate.busySince === null) gate.busySince = now;
    if (!gate.visible && now - gate.busySince >= gate.delayMs) {
      gate.visible = true;
      gate.shownAt = now;
    }
    // Already visible: nothing to wake for — the busy=false step decides the
    // hide time. Not yet visible: wake exactly at show-up time.
    return {
      visible: gate.visible,
      at: gate.visible ? null : gate.busySince + gate.delayMs,
    };
  }
  gate.busySince = null;
  if (!gate.visible) return { visible: false, at: null };
  const hideAt = gate.shownAt! + gate.minShowMs;
  if (now >= hideAt) {
    gate.visible = false;
    gate.shownAt = null;
    return { visible: false, at: null };
  }
  // Ended early: stay visible until the minimum show time is paid out.
  return { visible: true, at: hideAt };
}
