import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition } from './asset.service.js';

describe('asset lifecycle', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('planned', 'active')).toBe(true);
    expect(canTransition('active', 'under_maintenance')).toBe(true);
    expect(canTransition('under_maintenance', 'active')).toBe(true);
    expect(canTransition('active', 'retired')).toBe(true);
  });

  it('refuses skipping or reversing steps', () => {
    expect(canTransition('planned', 'under_maintenance')).toBe(false);
    expect(canTransition('active', 'planned')).toBe(false);
    expect(canTransition('active', 'active')).toBe(false);
  });

  it('treats retired as terminal', () => {
    expect(ALLOWED_TRANSITIONS.retired).toEqual([]);
    for (const to of ['planned', 'active', 'under_maintenance']) expect(canTransition('retired', to)).toBe(false);
  });

  it('refuses unknown statuses', () => {
    expect(canTransition('nonexistent', 'active')).toBe(false);
  });
});
