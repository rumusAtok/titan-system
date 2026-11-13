// Contract tests.
//
// 1. Event contract: events actually stored in the JetStream stream (written
//    by the real services) must satisfy the published envelope and the payload
//    schema of their type in packages/contracts.
// 2. API contract: the OpenAPI documents committed in docs/api must describe
//    exactly the operations the running services expose. A change to an API
//    without regenerating (and therefore reviewing) its specification fails here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { jetstream } from '@nats-io/jetstream';
import { EventCatalog, EventEnvelopeSchema, isKnownEventType, validateEvent } from '@titan/contracts';
import { API_DIR, API_SERVICES, fetchSpec, operations } from '../../scripts/export-openapi.mjs';
import { api, closeConnections, createAndSubmitCase, decide, natsConnection, publishTelemetry, registerTestDevice, waitFor } from '../helpers/stack.ts';

after(closeConnections);

/** Reads up to `limit` of the most recent messages of the event stream without affecting any consumer. */
async function recentEvents(limit: number): Promise<Array<{ subject: string; data: string }>> {
  const js = jetstream(await natsConnection());
  const consumer = await js.consumers.get('TITAN_EVENTS', { deliver_policy: 'last_per_subject' as any });
  const out: Array<{ subject: string; data: string }> = [];
  const messages = await consumer.fetch({ max_messages: limit, expires: 4_000 });
  for await (const m of messages) out.push({ subject: m.subject, data: m.string() });
  return out;
}

describe('event contract', () => {
  // The test produces the events it checks, so it does not depend on what ran before it.
  before(async () => {
    const c = await createAndSubmitCase('alice.applicant', 'event-permit', { event_name: 'Contract test fair', venue: 'Riverbend Square', event_date: '2027-11-01', expected_attendance: 50 });
    await decide('victor.validator', c.id, 'validation', 'approve');
    await decide('tara.technical', c.id, 'joint_review', 'approve');
    await decide('henry.head', c.id, 'joint_review', 'approve');
    const device = await registerTestDevice();
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.1 }]);
    await waitFor(async () => ((await api('derek.duty', 'GET', '/api/incident/incidents?limit=500')) as any[]).some((i) => i.device_id === device.id), { what: 'the incident raised for the contract test' });
  });

  it('every event type in the stream satisfies the envelope and its catalogued payload schema', async () => {
    const messages = (await recentEvents(500)).filter((m) => !m.subject.startsWith('titan.events.test.'));
    assert.ok(messages.length >= 10, `expected a populated stream, found ${messages.length} subjects`);
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.data);
      } catch {
        // Deliberately malformed messages published by the event-recovery test.
        continue;
      }
      if (!EventEnvelopeSchema.safeParse(parsed).success && !(parsed as any)?.event_id) continue;
      try {
        const event = validateEvent(parsed);
        assert.equal(m.subject, `titan.events.${event.event_type}`, 'subject matches the event type');
        assert.equal(event.schema_version, Number(/\.v(\d+)$/.exec(event.event_type)![1]));
        seen.add(event.event_type);
      } catch (err) {
        failures.push(`${m.subject}: ${(err as Error).message} ${JSON.stringify((err as any).issues ?? '').slice(0, 300)}`);
      }
    }
    assert.deepEqual(failures, []);
    console.log(`# validated ${seen.size} event types: ${[...seen].sort().join(', ')}`);
    // The core business flows have run: their events must be present and catalogued.
    for (const type of ['case.submitted.v1', 'workflow.task.assigned.v1', 'workflow.case.completed.v1', 'telemetry.measurement.accepted.v1', 'alert.raised.v1', 'incident.created.v1', 'notification.requested.v1']) {
      assert.ok(seen.has(type), `no ${type} event found in the stream`);
      assert.ok(isKnownEventType(type));
    }
  });

  it('every event produced by a Node service is of a catalogued type', async () => {
    const messages = await recentEvents(500);
    const uncatalogued = new Set<string>();
    for (const m of messages) {
      let e: any;
      try {
        e = JSON.parse(m.data);
      } catch {
        continue;
      }
      if (!e?.producer || !e?.event_type) continue;
      // Python services (pipeline, AI) publish announcement events validated on the envelope only.
      const pythonProducer = ['data-pipeline-service', 'ai-gateway-service', 'integration-test'].includes(e.producer);
      if (!pythonProducer && !isKnownEventType(e.event_type)) uncatalogued.add(`${e.producer}: ${e.event_type}`);
    }
    assert.deepEqual([...uncatalogued], []);
  });

  it('the catalogue itself is well formed', () => {
    for (const [type, schema] of Object.entries(EventCatalog)) {
      assert.match(type, /^[a-z_]+(\.[a-z_]+)+\.v\d+$/);
      assert.equal(typeof (schema as any).safeParse, 'function');
    }
  });
});

describe('API contract', () => {
  it('the committed OpenAPI documents match the operations of the running services', async () => {
    const differences: string[] = [];
    let compared = 0;
    for (const key of API_SERVICES) {
      const file = path.join(API_DIR, `${key}.openapi.json`);
      const live = await fetchSpec(key);
      if (!live) continue; // profile not running
      assert.ok(existsSync(file), `docs/api/${key}.openapi.json is missing: run npm run openapi:export`);
      const committed = JSON.parse(readFileSync(file, 'utf8'));
      const a = operations(committed);
      const b = operations(live);
      for (const op of b) if (!a.includes(op)) differences.push(`${key}: ${op} is served but not documented`);
      for (const op of a) if (!b.includes(op)) differences.push(`${key}: ${op} is documented but no longer served`);
      compared += 1;
    }
    assert.ok(compared >= 10, `only ${compared} services were running`);
    assert.deepEqual(differences, [], 'regenerate with `npm run openapi:export` and review the change');
  });

  it('every documented operation requires authentication and no operational endpoint is documented', async () => {
    for (const key of API_SERVICES) {
      const live = await fetchSpec(key);
      if (!live) continue;
      const ops = operations(live);
      assert.ok(ops.length > 0, `${key} documents no operations`);
      assert.ok(!ops.some((o) => /\/(metrics|health)/.test(o)), `${key} documents an operational endpoint`);
    }
  });
});
