import { describe, it, expect } from 'vitest';
import { shouldToggleTerminal, normalizeSessionId } from './terminalCore';

const key = (over: Partial<Parameters<typeof shouldToggleTerminal>[0]>) => ({
  metaKey: false, ctrlKey: false, code: 'Backquote', repeat: false, ...over,
});

describe('shouldToggleTerminal', () => {
  it('toggles on Ctrl+Backquote', () => {
    expect(shouldToggleTerminal(key({ ctrlKey: true }))).toBe(true);
  });

  it('toggles on Meta+Backquote (app Cmd/Ctrl convention)', () => {
    expect(shouldToggleTerminal(key({ metaKey: true }))).toBe(true);
  });

  it('ignores plain Backquote', () => {
    expect(shouldToggleTerminal(key({}))).toBe(false);
  });

  it('ignores other keys with modifiers', () => {
    expect(shouldToggleTerminal(key({ ctrlKey: true, code: 'KeyA' }))).toBe(false);
  });

  it('ignores auto-repeat so holding the key cannot flicker the panel', () => {
    expect(shouldToggleTerminal(key({ ctrlKey: true, repeat: true }))).toBe(false);
    expect(shouldToggleTerminal(key({ metaKey: true, repeat: true }))).toBe(false);
  });
});

describe('normalizeSessionId', () => {
  it('keeps null (mock.html contract: unknown invokes return null)', () => {
    expect(normalizeSessionId(null)).toBeNull();
  });

  it('passes through positive integers', () => {
    expect(normalizeSessionId(0 + 1)).toBe(1);
    expect(normalizeSessionId(42)).toBe(42);
  });

  it('rejects zero, negatives, floats, strings and objects', () => {
    expect(normalizeSessionId(0)).toBeNull();
    expect(normalizeSessionId(-3)).toBeNull();
    expect(normalizeSessionId(1.5)).toBeNull();
    expect(normalizeSessionId(NaN)).toBeNull();
    expect(normalizeSessionId('7')).toBeNull();
    expect(normalizeSessionId({ id: 7 })).toBeNull();
    expect(normalizeSessionId(undefined)).toBeNull();
  });
});
