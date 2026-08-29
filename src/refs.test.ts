import { describe, it, expect } from 'vitest';
import { filterRefs } from './refs';
import type { BranchRef } from './types';

// --- fixtures -------------------------------------------------------------

function ref(name: string, over: Partial<BranchRef> = {}): BranchRef {
  return { name, is_remote: false, is_tag: false, color: '#123456', ...over };
}

const mixed: BranchRef[] = [
  ref('main'),
  ref('origin/feat', { is_remote: true }),
  ref('v1.0', { is_tag: true }),
  ref('origin/main', { is_remote: true }),
];

// --- tests ----------------------------------------------------------------

describe('filterRefs', () => {
  it('hideRemotes=false returns the original array reference (no copy)', () => {
    // downstream memo identity depends on the pass-through (spec 4.3)
    expect(filterRefs(mixed, false)).toBe(mixed);
  });

  it('hideRemotes=true drops remote-tracking refs, keeps locals and tags in order', () => {
    const out = filterRefs(mixed, true);
    expect(out).not.toBe(mixed);
    expect(out.map(r => r.name)).toEqual(['main', 'v1.0']);
  });
});
