// Test A - Government approval, end to end through the API gateway.
// Real Keycloak tokens, real services, real PostgreSQL and NATS.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { api, caseStatus, closeConnections, createAndSubmitCase, decide, pendingTask, PERMIT_DATA, rawApi, unique, waitFor } from '../helpers/stack.ts';

after(closeConnections);

describe('Test A: multi-stage government approval', () => {
  let caseId: string;
  let reference: string;

  it('an applicant drafts an application, attaches a document and submits it', async () => {
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: `House extension ${unique()}`, data: PERMIT_DATA });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.channel, 'public');
    assert.match(draft.reference_no, /^APP-\d{4}-\d{6}$/);
    caseId = draft.id;
    reference = draft.reference_no;

    const attachment = await api('alice.applicant', 'POST', `/api/case/cases/${caseId}/attachments`, {
      filename: '../site plan.txt',
      content_type: 'text/plain',
      content_base64: Buffer.from('synthetic site plan').toString('base64'),
    });
    assert.equal(attachment.filename, 'site plan.txt');

    const submitted = await api('alice.applicant', 'POST', `/api/case/cases/${caseId}/submit`);
    assert.equal(submitted.status, 'submitted');
  });

  it('an incomplete application cannot be submitted', async () => {
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: 'Incomplete application', data: { applicant_name: 'Alice' } });
    const res = await rawApi('alice.applicant', 'POST', `/api/case/cases/${draft.id}/submit`);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d: any) => d.field === 'site_address'));
  });

  it('the case is assigned to the first reviewer role', async () => {
    const task = await pendingTask('victor.validator', caseId, 'validation');
    assert.equal(task.role, 'validation_officer');
    assert.equal(task.reference, reference);
    assert.ok(task.due_at, 'the task carries an SLA due date');
    const c = await caseStatus('alice.applicant', caseId, 'in_review');
    assert.equal(c.current_stage, 'Validation');
    // Reviewers of later stages have nothing to do yet.
    const later = await api('fiona.final', 'GET', `/api/workflow/tasks?subject_id=${caseId}`);
    assert.equal(later.length, 0);
  });

  it('unauthorised decision attempts are denied', async () => {
    const task = await pendingTask('victor.validator', caseId, 'validation');
    const path = `/api/workflow/tasks/${task.id}/decision`;
    // Wrong role within the same tenant.
    assert.equal((await rawApi('tara.technical', 'POST', path, { decision: 'approve' })).status, 403);
    assert.equal((await rawApi('fiona.final', 'POST', path, { decision: 'approve' })).status, 403);
    // The applicant cannot approve anything.
    assert.equal((await rawApi('alice.applicant', 'POST', path, { decision: 'approve' })).status, 403);
    // The right role in ANOTHER tenant cannot even see the task.
    assert.equal((await rawApi('vera.validator', 'POST', path, { decision: 'approve' })).status, 404);
    // No token at all.
    assert.equal((await rawApi(null, 'POST', path, { decision: 'approve' })).status, 401);
    // Nothing changed.
    const still = await pendingTask('victor.validator', caseId, 'validation');
    assert.equal(still.id, task.id);
  });

  it('no approval notification exists before the final decision', async () => {
    await decide('victor.validator', caseId, 'validation', 'approve', 'Documents complete');
    await decide('tara.technical', caseId, 'technical_review', 'approve');
    await decide('henry.head', caseId, 'department_endorsement', 'approve');
    await pendingTask('fiona.final', caseId, 'final_approval');
    const deliveries = await api('adam.admin', 'GET', `/api/notification/deliveries?reference_id=${caseId}`);
    assert.ok(!deliveries.some((d: any) => d.category === 'case.approved'), 'approval must not be announced before it is decided');
    assert.equal((await api('alice.applicant', 'GET', `/api/case/cases/${caseId}`)).status, 'in_review');
  });

  it('the final approver completes the process and the case becomes approved', async () => {
    const result = await decide('fiona.final', caseId, 'final_approval', 'approve', 'Approved');
    assert.equal(result.instance_status, 'approved');
    const c = await caseStatus('alice.applicant', caseId, 'approved');
    assert.ok(c.decided_at);
    assert.equal(c.current_stage, null);
  });

  it('the applicant receives exactly the configured notifications, after the decision', async () => {
    const mine = await waitFor(
      async () => {
        const list = await api('alice.applicant', 'GET', '/api/notification/notifications?limit=200');
        const forCase = list.filter((n: any) => n.reference_id === caseId);
        return forCase.some((n: any) => n.category === 'case.approved') ? forCase : null;
      },
      { what: 'the approval notification' },
    );
    // Configured milestones for this workflow: submitted, returned, approved, rejected.
    // This case was submitted and approved: exactly those two, and nothing about internal stages.
    assert.deepEqual(mine.map((n: any) => n.category).sort(), ['case.approved', 'case.submitted']);

    const delivery = await waitFor(
      async () => {
        const all = await api('adam.admin', 'GET', `/api/notification/deliveries?reference_id=${caseId}&channel=email`);
        const approved = all.find((d: any) => d.category === 'case.approved');
        return approved?.status === 'sent' ? approved : null;
      },
      { what: 'delivery of the approval e-mail' },
    );
    assert.equal(delivery.external, true);
    assert.equal(delivery.adapter, 'log');
    assert.equal(delivery.recipient_address, 'alice.applicant@titan.example');
  });

  it('the applicant can track status and see the full lifecycle', async () => {
    const tracked = await api('alice.applicant', 'GET', `/api/case/cases/track/${reference}`);
    assert.equal(tracked.status, 'approved');
    const statuses = tracked.timeline.map((t: any) => t.status);
    assert.deepEqual([...new Set(statuses)], ['draft', 'submitted', 'in_review', 'approved']);
    // Another applicant of the same tenant cannot track it.
    assert.equal((await rawApi('aaron.applicant', 'GET', `/api/case/cases/track/${reference}`)).status, 404);
  });

  it('the decision history is complete and attributed', async () => {
    const instance = await api('victor.validator', 'GET', `/api/workflow/instances/by-subject/case/${caseId}`);
    assert.equal(instance.status, 'approved');
    assert.deepEqual(
      instance.decisions.map((d: any) => [d.stage_key, d.decision, d.decided_by_username]),
      [
        ['validation', 'approve', 'victor.validator'],
        ['technical_review', 'approve', 'tara.technical'],
        ['department_endorsement', 'approve', 'henry.head'],
        ['final_approval', 'approve', 'fiona.final'],
      ],
    );
    assert.ok(instance.tasks.every((t: any) => t.status === 'completed'));
  });

  it('the audit trail records the submission, every decision, the completion and the denied attempts', async () => {
    const audit = await waitFor(
      async () => {
        const [byCase, decisions, denied] = await Promise.all([
          api('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${caseId}&limit=100`),
          api('oscar.auditor', 'GET', '/api/audit/audit?event_type=workflow.decision.approved.v1&limit=500'),
          api('oscar.auditor', 'GET', '/api/audit/audit?event_type=security.access_denied.v1&limit=500'),
        ]);
        const types = byCase.items.map((e: any) => e.event_type);
        const mine = decisions.items.filter((e: any) => e.payload.subject_id === caseId);
        return types.includes('workflow.case.completed.v1') && mine.length === 4 ? { types, mine, denied: denied.items } : null;
      },
      { what: 'audit records' },
    );
    assert.ok(audit.types.includes('case.submitted.v1'));
    assert.ok(audit.types.includes('workflow.case.completed.v1'));
    assert.deepEqual(audit.mine.map((e: any) => e.actor_username).sort(), ['fiona.final', 'henry.head', 'tara.technical', 'victor.validator']);
    // Every audit record is traceable: it carries correlation metadata.
    assert.ok(audit.mine.every((e: any) => e.correlation_id && e.producer === 'workflow-service'));
    assert.ok(audit.denied.some((e: any) => e.actor_username === 'tara.technical' && e.payload.path.includes('/decision')));
    // Audit records are not readable by ordinary staff.
    assert.equal((await rawApi('victor.validator', 'GET', '/api/audit/audit')).status, 403);
  });
});

describe('Test A: return, resubmission and rejection', () => {
  it('a returned case goes back to the applicant, can be corrected and resubmitted, and restarts review', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    assert.equal((await rawApi('victor.validator', 'POST', `/api/workflow/tasks/${(await pendingTask('victor.validator', c.id, 'validation')).id}/decision`, { decision: 'return' })).status, 400, 'returning needs a comment');
    await decide('victor.validator', c.id, 'validation', 'return', 'Floor area looks wrong');
    const returned = await caseStatus('alice.applicant', c.id, 'returned');

    await api('alice.applicant', 'PATCH', `/api/case/cases/${c.id}`, { data: { ...PERMIT_DATA, floor_area_m2: 155 }, expected_version: returned.version });
    await api('alice.applicant', 'POST', `/api/case/cases/${c.id}/submit`);

    const again = await pendingTask('victor.validator', c.id, 'validation');
    assert.ok(again, 'review restarts at the first stage');
    await caseStatus('alice.applicant', c.id, 'in_review');
    const history = await api('alice.applicant', 'GET', `/api/case/cases/${c.id}/history`);
    assert.ok(history.some((h: any) => h.to_status === 'returned' && h.note === 'Floor area looks wrong'));
    const notes = await waitFor(async () => {
      const list = (await api('alice.applicant', 'GET', '/api/notification/notifications?limit=200')).filter((n: any) => n.reference_id === c.id);
      return list.some((n: any) => n.category === 'case.returned') ? list : null;
    });
    assert.ok(notes.some((n: any) => n.category === 'case.returned'));
  });

  it('a rejection at any stage ends the process and notifies the applicant', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    await decide('victor.validator', c.id, 'validation', 'approve');
    const result = await decide('tara.technical', c.id, 'technical_review', 'reject', 'Does not meet the structural code');
    assert.equal(result.instance_status, 'rejected');
    await caseStatus('alice.applicant', c.id, 'rejected');
    assert.equal((await api('henry.head', 'GET', `/api/workflow/tasks?subject_id=${c.id}`)).length, 0, 'no further tasks are created');
    await waitFor(async () => (await api('alice.applicant', 'GET', '/api/notification/notifications?limit=200')).some((n: any) => n.reference_id === c.id && n.category === 'case.rejected'));
  });

  it('an applicant can cancel a case under review, which withdraws the pending task', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    await pendingTask('victor.validator', c.id, 'validation');
    await api('alice.applicant', 'POST', `/api/case/cases/${c.id}/cancel`);
    await waitFor(async () => (await api('victor.validator', 'GET', `/api/workflow/tasks?subject_id=${c.id}`)).length === 0, { what: 'the pending task to be withdrawn' });
    assert.equal((await api('alice.applicant', 'GET', `/api/case/cases/${c.id}`)).status, 'cancelled');
  });
});

describe('Test A: parallel review, conditional routing and delegation', () => {
  const event = (attendance: number) => ({ event_name: 'Synthetic street fair', venue: 'Riverbend Square', event_date: '2027-06-12', expected_attendance: attendance });

  it('a parallel stage needs every reviewer, and a small event skips the conditional final stage', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'event-permit', event(200));
    await decide('victor.validator', c.id, 'validation', 'approve');

    const [technical, head] = await Promise.all([pendingTask('tara.technical', c.id, 'joint_review'), pendingTask('henry.head', c.id, 'joint_review')]);
    assert.notEqual(technical.id, head.id, 'each role gets its own task');

    const first = await api('tara.technical', 'POST', `/api/workflow/tasks/${technical.id}/decision`, { decision: 'approve' });
    assert.equal(first.instance_status, 'running', 'one approval is not enough');
    // The case status follows workflow events asynchronously: wait for it (bounded), then make
    // sure the single approval did not move it any further.
    await caseStatus('alice.applicant', c.id, 'in_review');
    assert.equal((await api('alice.applicant', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`)).status, 'running');

    const second = await api('henry.head', 'POST', `/api/workflow/tasks/${head.id}/decision`, { decision: 'approve' });
    assert.equal(second.instance_status, 'approved', 'attendance below 1000 skips final approval');
    await caseStatus('alice.applicant', c.id, 'approved');
    const instance = await api('henry.head', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`);
    assert.deepEqual(instance.stages.map((s: any) => s.key), ['validation', 'joint_review']);
  });

  it('a large event is routed through the conditional final-approval stage', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'event-permit', event(5000));
    await decide('victor.validator', c.id, 'validation', 'approve');
    await decide('tara.technical', c.id, 'joint_review', 'approve');
    const afterJoint = await decide('henry.head', c.id, 'joint_review', 'approve');
    assert.equal(afterJoint.instance_status, 'running');
    const final = await pendingTask('fiona.final', c.id, 'final_approval');
    assert.equal(final.role, 'final_approver');
  });

  it('a delegate can decide on behalf of the delegator, only for the delegated role and only while the delegation is active', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    await decide('victor.validator', c.id, 'validation', 'approve');
    await decide('tara.technical', c.id, 'technical_review', 'approve');
    await decide('henry.head', c.id, 'department_endorsement', 'approve');
    const finalTask = await pendingTask('fiona.final', c.id, 'final_approval');
    const path = `/api/workflow/tasks/${finalTask.id}/decision`;

    assert.equal((await rawApi('henry.head', 'POST', path, { decision: 'approve' })).status, 403, 'no delegation yet');
    // You cannot delegate a role you do not hold.
    assert.equal((await rawApi('henry.head', 'POST', '/api/workflow/delegations', { to_username: 'tara.technical', role: 'final_approver', valid_to: new Date(Date.now() + 3600_000).toISOString() })).status, 403);

    const delegation = await api('fiona.final', 'POST', '/api/workflow/delegations', {
      to_username: 'henry.head',
      role: 'final_approver',
      reason: 'On leave',
      valid_to: new Date(Date.now() + 3600_000).toISOString(),
    });
    const inbox = await api('henry.head', 'GET', `/api/workflow/tasks?subject_id=${c.id}`);
    assert.ok(inbox.some((t: any) => t.id === finalTask.id), 'the delegated task appears in the delegate inbox');

    // Revoked delegations stop working immediately.
    await api('fiona.final', 'DELETE', `/api/workflow/delegations/${delegation.id}`);
    assert.equal((await rawApi('henry.head', 'POST', path, { decision: 'approve' })).status, 403);

    await api('fiona.final', 'POST', '/api/workflow/delegations', { to_username: 'henry.head', role: 'final_approver', valid_to: new Date(Date.now() + 3600_000).toISOString() });
    const result = await api('henry.head', 'POST', path, { decision: 'approve', comment: 'Approved under delegation' });
    assert.equal(result.instance_status, 'approved');
    const instance = await api('fiona.final', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`);
    const last = instance.decisions.at(-1);
    assert.equal(last.decided_by_username, 'henry.head');
    assert.ok(last.on_behalf_of, 'the decision records on whose behalf it was made');

    // Clean up so later runs start without an active delegation.
    for (const d of await api('fiona.final', 'GET', '/api/workflow/delegations')) if (d.active) await api('fiona.final', 'DELETE', `/api/workflow/delegations/${d.id}`);
  });
});
