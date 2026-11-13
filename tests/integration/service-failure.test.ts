// Test G - Service failure.
// Stops non-critical services (real containers) and verifies that critical
// functions keep working, failures are contained, and state is consistent
// after the services return.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { api, caseStatus, closeConnections, createAndSubmitCase, decide, rawApi, startService, stopService, waitFor } from '../helpers/stack.ts';

const NON_CRITICAL = ['notification-service', 'audit-service'];

after(async () => {
  await startService(...NON_CRITICAL).catch(() => undefined);
  await closeConnections();
});

describe('Test G: non-critical services fail', () => {
  let caseId: string;
  const event = { event_name: 'Outage drill fair', venue: 'Riverbend Square', event_date: '2027-08-01', expected_attendance: 150 };

  it('the platform reports a degraded (not critical) state', async () => {
    stopService(...NON_CRITICAL);
    const health = await waitFor(
      async () => {
        const h = await api('adam.admin', 'GET', '/api/platform/health');
        return NON_CRITICAL.every((n) => h.services.find((s: any) => s.service === n).status === 'unreachable') ? h : null;
      },
      { what: 'the outage to be visible' },
    );
    assert.equal(health.status, 'degraded');
    assert.equal(health.services.find((s: any) => s.service === 'case-service').status, 'ok');
    assert.equal(health.services.find((s: any) => s.service === 'workflow-service').status, 'ok');
  });

  it('a complete approval still runs while notifications and audit are down', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'event-permit', event);
    caseId = c.id;
    await decide('victor.validator', caseId, 'validation', 'approve');
    await decide('tara.technical', caseId, 'joint_review', 'approve');
    const last = await decide('henry.head', caseId, 'joint_review', 'approve');
    assert.equal(last.instance_status, 'approved');
    await caseStatus('alice.applicant', caseId, 'approved');
  });

  it('other operations are unaffected, and the failed services fail fast instead of hanging', async () => {
    assert.equal((await rawApi('amy.assets', 'GET', '/api/asset/assets/summary')).status, 200);
    assert.equal((await rawApi('derek.duty', 'GET', '/api/incident/incidents/summary')).status, 200);

    const timings: number[] = [];
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const started = Date.now();
      last = (await rawApi('alice.applicant', 'GET', '/api/notification/notifications')).status;
      timings.push(Date.now() - started);
      assert.ok([502, 503].includes(last), `expected 502/503, got ${last}`);
    }
    // After repeated failures the circuit opens: the gateway answers without calling the service.
    const res = await rawApi('alice.applicant', 'GET', '/api/notification/notifications');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'upstream_unavailable');
    assert.ok(res.headers.get('retry-after'));
    assert.ok(Math.max(...timings) < 5_000, `no request hung (slowest ${Math.max(...timings)} ms)`);
  });

  it('after restart, the notifications and audit records of the outage period appear (nothing was lost)', async () => {
    await startService(...NON_CRITICAL);

    const notifications = await waitFor(
      async () => {
        const res = await rawApi('alice.applicant', 'GET', '/api/notification/notifications?limit=200');
        if (res.status !== 200) return null; // circuit still half-open
        const mine = (res.body as any[]).filter((n) => n.reference_id === caseId);
        return mine.some((n) => n.category === 'case.approved') ? mine : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000, what: 'the approval notification after recovery' },
    );
    // event-permit notifies the applicant on returned/approved/rejected only.
    assert.deepEqual(notifications.map((n: any) => n.category), ['case.approved']);

    const audit = await waitFor(
      async () => {
        const res = await rawApi('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${caseId}&limit=100`);
        if (res.status !== 200) return null;
        const types = (res.body.items as any[]).map((e) => e.event_type);
        return types.includes('workflow.case.completed.v1') ? types : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000, what: 'audit records after recovery' },
    );
    assert.ok(audit.includes('case.submitted.v1'));

    const decisions = await waitFor(async () => {
      const res = await api('oscar.auditor', 'GET', '/api/audit/audit?event_type=workflow.decision.approved.v1&limit=500');
      const mine = (res.items as any[]).filter((e) => e.payload.subject_id === caseId);
      return mine.length === 3 ? mine : null;
    }, { what: 'all three decisions in the audit trail' });
    assert.equal(decisions.length, 3);

    const health = await api('adam.admin', 'GET', '/api/platform/health');
    assert.ok(NON_CRITICAL.every((n) => health.services.find((s: any) => s.service === n).status === 'ok'));
  });
});
