import { describe, expect, it } from 'vitest';
import { describeOrigin, responseOverdue } from './rules.js';

const at = (minutesAgo: number, now: Date) => new Date(now.getTime() - minutesAgo * 60_000);

describe('responseOverdue', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const targets = { critical: 10, warning: 30 };

  it('flags an unacknowledged incident past the target of its severity', () => {
    expect(responseOverdue({ status: 'open', severity: 'critical', created_at: at(11, now) }, targets, now)).toBe(true);
    expect(responseOverdue({ status: 'open', severity: 'critical', created_at: at(9, now) }, targets, now)).toBe(false);
    expect(responseOverdue({ status: 'open', severity: 'warning', created_at: at(11, now) }, targets, now)).toBe(false);
  });

  it('never flags an incident that has been acknowledged, resolved or closed', () => {
    for (const status of ['acknowledged', 'resolved', 'closed']) {
      expect(responseOverdue({ status, severity: 'critical', created_at: at(600, now) }, targets, now)).toBe(false);
    }
  });

  it('never flags a severity or category without a target', () => {
    expect(responseOverdue({ status: 'open', severity: 'info', created_at: at(600, now) }, targets, now)).toBe(false);
    expect(responseOverdue({ status: 'open', severity: 'critical', created_at: at(600, now) }, {}, now)).toBe(false);
  });
});

describe('describeOrigin', () => {
  it('keeps the original wording for alarms and manual reports', () => {
    expect(describeOrigin('alert')).toBe('Incident raised automatically from an alarm');
    expect(describeOrigin('manual')).toBe('Incident reported manually');
  });

  it('describes the origins added later', () => {
    expect(describeOrigin('inspection')).toContain('inspection');
    expect(describeOrigin('service_request')).toContain('service request');
  });
});
