// Pure logic for the embedded terminal — kept out of the component so the
// keybinding and mock-degradation contracts are unit-testable without a
// PTY (mirrors locate.ts / inactive.ts).

/** Minimal shape of KeyboardEvent the toggle rule reads. */
export interface ToggleKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  code: string;
  repeat: boolean;
}

/** Ctrl+` toggles the terminal panel (meta/Cmd accepted too, matching the
 *  existing Cmd/Ctrl+, settings-dialog convention). Auto-repeat is ignored
 *  so holding the key doesn't flicker the panel open and closed. */
export function shouldToggleTerminal(e: ToggleKeyEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.code === 'Backquote' && !e.repeat;
}

/** Normalize a ptySpawn result into a usable session id. null (the browser
 *  mock's fallback for unknown invokes) stays null; only real positive
 *  integers pass — anything else (strings, floats, NaN) is rejected so a
 *  malformed payload can never address a session. */
export function normalizeSessionId(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null;
  return v;
}
