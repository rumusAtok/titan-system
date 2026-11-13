// Performance smoke test (NOT a capacity test).
//
//   node tests/performance/smoke.mjs
//
// Measures, on the local single-host stack with synthetic data:
//   1. latency of representative read endpoints through the gateway, and that
//      the per-user rate limit is enforced;
//   2. end-to-end time from an MQTT reading to the persisted measurement;
//   3. end-to-end time from a threshold-crossing reading to an open incident.
// The numbers describe this laptop-sized lab only. They exist to catch gross
// regressions, not to state what the platform can carry.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { api, claimsOf, config, rawApi, sleep, tokenFor, waitFor } from '../../scripts/lib/titan-client.mjs';

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const stats = (values) => ({ samples: values.length, p50_ms: Math.round(percentile(values, 50)), p95_ms: Math.round(percentile(values, 95)), max_ms: Math.round(Math.max(...values)) });

async function timeRequests(user, path, count, concurrency) {
  await tokenFor(user);
  const timings = [];
  let errors = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        next += 1;
        const started = performance.now();
        const res = await rawApi(user, 'GET', path);
        if (res.status !== 200) errors += 1;
        timings.push(performance.now() - started);
      }
    }),
  );
  return { path, concurrency, errors, ...stats(timings) };
}

const results = { ran_at: new Date().toISOString(), environment: 'single-host docker compose, synthetic data', reads: [], rate_limit: null, telemetry: null, alarm_to_incident: null };

// Each endpoint is called by a different user and stays inside the gateway's
// per-user burst allowance (a quarter of RATE_LIMIT_PER_MINUTE), so that
// latency is measured without throttling.
console.log('Read latency through the gateway (authenticated, 100 requests each, 5 concurrent)');
for (const [user, path] of [
  ['alice.applicant', '/api/case/cases?limit=50'],
  ['victor.validator', '/api/workflow/tasks'],
  ['derek.duty', '/api/telemetry/latest'],
  ['irene.commander', '/api/incident/incidents?limit=50'],
  ['amy.assets', '/api/asset/assets'],
]) {
  const r = await timeRequests(user, path, 100, 5);
  results.reads.push(r);
  console.log(`  ${path.padEnd(36)} p50 ${String(r.p50_ms).padStart(4)} ms   p95 ${String(r.p95_ms).padStart(4)} ms   max ${String(r.max_ms).padStart(4)} ms   errors ${r.errors}`);
}

// --- rate limiting on the live gateway -------------------------------------------
console.log('');
console.log('Overload protection (one user, 400 simultaneous requests)');
{
  await tokenFor('anna.analyst');
  const responses = await Promise.all(
    Array.from({ length: 400 }, () => rawApi('anna.analyst', 'GET', '/api/asset/assets/summary').then((r) => ({ status: r.status, code: r.body?.error?.code ?? null, retryAfter: r.headers.get('retry-after') }))),
  );
  const ok = responses.filter((x) => x.status === 200).length;
  // Beyond the per-user allowance: refused by the rate limiter.
  const throttled = responses.filter((x) => x.status === 429);
  // Inside the allowance but more than the per-service concurrency budget: shed by the bulkhead.
  const shed = responses.filter((x) => x.status === 503 && x.code === 'upstream_overloaded');
  const other = responses.length - ok - throttled.length - shed.length;
  await sleep(1_000);
  // A different user is unaffected by anna's exhausted allowance.
  const neighbour = await rawApi('oscar.auditor', 'GET', '/api/asset/assets/summary');
  results.rate_limit = {
    requests: 400,
    served: ok,
    throttled_429: throttled.length,
    shed_by_bulkhead_503: shed.length,
    other_statuses: other,
    retry_after_header_present: [...throttled, ...shed].every((x) => x.retryAfter),
    other_user_status: neighbour.status,
  };
  console.log(`  served ${ok}; rate-limited ${throttled.length} (429); shed by the concurrency bulkhead ${shed.length} (503); unexpected ${other}; another user right after: ${neighbour.status}`);
}

// --- telemetry path ---------------------------------------------------------------
const admin = 'adam.admin';
const tenantId = claimsOf(await tokenFor(admin)).tenant_id;
const device = await api(admin, 'POST', '/api/device/devices', {
  serial_no: `PERF-${Date.now().toString(36).toUpperCase()}`,
  name: 'Performance smoke sensor',
  device_type: 'flood-monitoring-station',
  expected_interval_seconds: 3600,
  sensors: [{ kind: 'water_level', unit: 'm', min_valid: 0, max_valid: 15 }],
});
const client = await mqtt.connectAsync(config.mqttUrl, { clientId: `perf-${randomUUID()}`, username: config.mqttUser, password: config.mqttPassword });
const publish = (value) => {
  const id = `perf-${randomUUID()}`;
  return client.publishAsync(`titan/${tenantId}/devices/${device.id}/telemetry`, JSON.stringify({ message_id: id, observed_at: new Date().toISOString(), readings: [{ sensor: 'water_level', value }] }), { qos: 1 }).then(() => id);
};
const stored = async (id) => (await api(admin, 'GET', `/api/telemetry/measurements?device_id=${device.id}&limit=500`)).find((m) => m.message_id === id);

// The new device reaches telemetry-service through an event: wait until it is known.
await waitFor(async () => stored(await publish(1.0)), { timeoutMs: 30_000, intervalMs: 400, what: 'device to be known to telemetry-service' });

console.log('\nMQTT publish to persisted measurement (30 readings)');
const ingest = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  const id = await publish(1.5 + i * 0.01);
  await waitFor(() => stored(id), { timeoutMs: 15_000, intervalMs: 25, what: 'measurement' });
  ingest.push(performance.now() - started);
}
results.telemetry = { note: 'includes the polling interval of this test (25 ms) and one API round trip', ...stats(ingest) };
console.log(`  p50 ${results.telemetry.p50_ms} ms   p95 ${results.telemetry.p95_ms} ms   max ${results.telemetry.max_ms} ms`);

console.log('\nThreshold-crossing reading to open incident (5 runs)');
const chain = [];
for (let i = 0; i < 5; i++) {
  const started = performance.now();
  await publish(4.0);
  const incident = await waitFor(async () => (await api('derek.duty', 'GET', '/api/incident/incidents?status=open&limit=200')).find((x) => x.device_id === device.id), { timeoutMs: 30_000, intervalMs: 50, what: 'incident' });
  chain.push(performance.now() - started);
  // Reset for the next run: clear the alarm, and take the incident through its response steps.
  await publish(1.0);
  for (const [user, stage] of [['derek.duty', 'acknowledge'], ['irene.commander', 'resolve']]) {
    const task = await waitFor(async () => (await api(user, 'GET', `/api/workflow/tasks?subject_id=${incident.id}`)).find((t) => t.stage_key === stage), { timeoutMs: 20_000, intervalMs: 100, what: `${stage} task` });
    await api(user, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
  }
  await waitFor(async () => (await api('derek.duty', 'GET', `/api/alert/alerts?status=open&device_id=${device.id}`)).length === 0, { timeoutMs: 20_000, intervalMs: 100, what: 'alarm to clear' });
  await sleep(200);
}
results.alarm_to_incident = { note: 'MQTT -> telemetry -> alert -> incident: three services and two event hops', ...stats(chain) };
console.log(`  p50 ${results.alarm_to_incident.p50_ms} ms   p95 ${results.alarm_to_incident.p95_ms} ms   max ${results.alarm_to_incident.max_ms} ms`);

await client.endAsync();
await api(admin, 'POST', `/api/device/devices/${device.id}/decommission`);

const out = fileURLToPath(new URL('./last-result.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nSaved to tests/performance/last-result.json`);
const rl = results.rate_limit;
const failed = results.reads.some((r) => r.errors > 0) || rl.throttled_429 === 0 || rl.other_statuses > 0 || rl.other_user_status !== 200 || !rl.retry_after_header_present;
if (failed) {
  console.error('Unexpected result: failed reads, or the rate limiter did not behave as specified.');
  process.exit(1);
}
