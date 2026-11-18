// Stepped load test through the API gateway (lab only; NOT a capacity statement).
//
//   node tests/performance/load.mjs [--stages 10,25,50] [--seconds 30]
//
// Virtual users (spread over several demo users in two tenants, so the per-user rate limit of
// the gateway is not the only thing measured) loop over a weighted mix of real read requests
// and a small share of writes. For each stage it reports throughput, latency percentiles,
// server errors and rate-limited answers, and writes tests/performance/load-result.json.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api, rawApi, tokenFor } from '../../scripts/lib/titan-client.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const STAGES = arg('stages', '10,25,50').split(',').map(Number);
const SECONDS = Number(arg('seconds', '30'));

const USERS = {
  riverbend: ['adam.admin', 'anna.analyst', 'derek.duty', 'irene.commander', 'owen.officer', 'sid.stores', 'rex.records', 'sara.security'],
  meridian: ['maya.admin', 'paula.planner', 'priya.procurement', 'stan.stores', 'sam.supervisor', 'fred.facilities', 'rachel.records', 'sol.security'],
};

// Weighted request mix: [weight, label, method, path(user) | null when not applicable to the user].
const MIX = [
  [14, 'incidents', 'GET', () => '/api/incident/incidents?status=active&limit=50'],
  [12, 'assets', 'GET', () => '/api/asset/assets?limit=100'],
  [10, 'work inbox', 'GET', () => '/api/workflow/tasks'],
  [10, 'documents', 'GET', () => '/api/document/documents?limit=50'],
  [8, 'stock', 'GET', () => '/api/procurement/items'],
  [8, 'zones and layers', 'GET', () => '/api/geo/layers'],
  [8, 'cameras', 'GET', () => '/api/video/cameras'],
  [8, 'notifications', 'GET', () => '/api/notification/notifications?limit=20'],
  [6, 'work orders', 'GET', (t) => (t === 'meridian' ? '/api/maintenance/work-orders?status=active' : '/api/incident/incidents?limit=20')],
  [6, 'workspace', 'GET', () => '/api/tenant/workspace'],
  [4, 'dataset query', 'POST', () => '/api/analytics/datasets/incidents_by_severity/query'],
  [3, 'full-text search', 'GET', () => '/api/document/documents?text=pump%20seal'],
  [3, 'point lookup', 'GET', () => '/api/geo/locate?lat=3.08&lon=101.52'],
  // Writes: an applicant saves an application draft (Riverbend), synthetic and left in place.
  [4, 'write: application draft', 'POST', () => '/api/case/cases', { form_key: 'event-permit', title: 'Load test draft', data: { event_name: 'Load test', venue: 'Riverbend Square', event_date: '2027-10-01', expected_attendance: 50 } }, 'alice.applicant'],
];
const TOTAL = MIX.reduce((s, m) => s + m[0], 0);
const pick = () => {
  let r = Math.random() * TOTAL;
  for (const m of MIX) if ((r -= m[0]) < 0) return m;
  return MIX[0];
};

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

async function stage(vus) {
  const timings = [];
  const byLabel = {};
  let errors = 0;
  let limited = 0;
  const sample = [];
  const end = Date.now() + SECONDS * 1000;
  const all = Object.entries(USERS).flatMap(([tenant, users]) => users.map((u) => [tenant, u]));
  await Promise.all(
    Array.from({ length: vus }, async (_, i) => {
      const [tenant, user] = all[i % all.length];
      while (Date.now() < end) {
        const [, label, method, path, body, asUser] = pick();
        const started = performance.now();
        let status;
        try {
          status = (await rawApi(asUser ?? user, method, path(tenant), method === 'POST' ? (body ?? { limit: 50 }) : undefined)).status;
        } catch {
          status = 0;
        }
        const ms = performance.now() - started;
        // Latency is reported for SERVED requests only: a rate-limited answer is fast by design.
        if (status === 429) {
          limited += 1;
          continue;
        }
        timings.push(ms);
        (byLabel[label] ??= []).push(ms);
        if (status >= 500 || status === 0) {
          errors += 1;
          if (sample.length < 5) sample.push(`${label} -> ${status}`);
        }
      }
    }),
  );
  timings.sort((a, b) => a - b);
  return {
    virtual_users: vus,
    seconds: SECONDS,
    served_requests: timings.length,
    served_rps: Math.round((timings.length / SECONDS) * 10) / 10,
    p50_ms: Math.round(percentile(timings, 50)),
    p95_ms: Math.round(percentile(timings, 95)),
    p99_ms: Math.round(percentile(timings, 99)),
    server_errors: errors,
    error_rate_pct: Math.round((errors / Math.max(1, timings.length)) * 10000) / 100,
    rate_limited: limited,
    error_samples: sample,
    p95_by_request_ms: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, Math.round(percentile(v.sort((a, b) => a - b), 95))])),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Load test: stages ${STAGES.join(', ')} virtual users, ${SECONDS} s each (single-host lab, synthetic data)`);
  for (const u of [...Object.values(USERS).flat(), 'alice.applicant']) await tokenFor(u);
  await api('adam.admin', 'GET', '/api/platform/health');
  const results = [];
  for (const vus of STAGES) {
    const r = await stage(vus);
    results.push(r);
    console.log(`  ${vus} VUs: ${r.served_requests} served, ${r.served_rps} req/s, p50 ${r.p50_ms} ms, p95 ${r.p95_ms} ms, p99 ${r.p99_ms} ms, ${r.server_errors} server errors (${r.error_rate_pct}%), ${r.rate_limited} rate-limited`);
    if (r.error_samples.length) console.log(`     errors: ${r.error_samples.join('; ')}`);
  }
  const out = { run_at: new Date().toISOString(), environment: 'single-host docker compose lab on a workstation; synthetic data; NOT a capacity statement', gateway_rate_limit_per_minute: process.env.RATE_LIMIT_PER_MINUTE ?? 'as configured', stages: results };
  writeFileSync(fileURLToPath(new URL('./load-result.json', import.meta.url)), `${JSON.stringify(out, null, 2)}\n`);
  console.log('Written to tests/performance/load-result.json');
}
