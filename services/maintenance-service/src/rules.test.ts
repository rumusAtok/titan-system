import { describe, expect, it } from 'vitest';
import { canPerform, hoursBetween, mayExecute, priorityFromSeverity } from './rules.js';

describe('priorityFromSeverity', () => {
  it('maps incident severity to request priority', () => {
    expect(priorityFromSeverity('critical', 'normal')).toBe('urgent');
    expect(priorityFromSeverity('warning', 'normal')).toBe('high');
    expect(priorityFromSeverity('info', 'high')).toBe('normal');
  });

  it('uses the request type default for an unknown severity', () => {
    expect(priorityFromSeverity('unknown', 'low')).toBe('low');
  });
});

describe('work order lifecycle', () => {
  it('follows open -> assigned -> in_progress -> completed', () => {
    expect(canPerform('assign', 'open')).toBe(true);
    expect(canPerform('start', 'assigned')).toBe(true);
    expect(canPerform('complete', 'in_progress')).toBe(true);
  });

  it('does not skip steps', () => {
    expect(canPerform('start', 'open')).toBe(false);
    expect(canPerform('complete', 'open')).toBe(false);
    expect(canPerform('complete', 'assigned')).toBe(false);
  });

  it('allows re-assignment only before work starts', () => {
    expect(canPerform('assign', 'assigned')).toBe(true);
    expect(canPerform('assign', 'in_progress')).toBe(false);
  });

  it('treats completed and cancelled as final', () => {
    for (const action of ['assign', 'start', 'complete', 'cancel'] as const) {
      expect(canPerform(action, 'completed')).toBe(false);
      expect(canPerform(action, 'cancelled')).toBe(false);
    }
  });
});

describe('mayExecute', () => {
  const planning = ['maintenance_planner', 'facility_manager'];

  it('allows the assignee and planning roles', () => {
    expect(mayExecute({ userId: 'u1', roles: ['maintenance_technician'] }, 'u1', planning)).toBe(true);
    expect(mayExecute({ userId: 'u2', roles: ['maintenance_planner'] }, 'u1', planning)).toBe(true);
  });

  it('refuses another technician, and anyone when nobody is assigned', () => {
    expect(mayExecute({ userId: 'u2', roles: ['maintenance_technician'] }, 'u1', planning)).toBe(false);
    expect(mayExecute({ userId: 'u1', roles: ['maintenance_technician'] }, null, planning)).toBe(false);
  });
});

describe('hoursBetween', () => {
  it('returns hours with two decimals, or null when a time is missing', () => {
    expect(hoursBetween(new Date('2026-11-16T10:00:00Z'), new Date('2026-11-16T11:30:00Z'))).toBe(1.5);
    expect(hoursBetween(null, new Date())).toBeNull();
  });
});
