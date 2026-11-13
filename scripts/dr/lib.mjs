// Shared helpers for the disaster-recovery scripts.
// Everything here drives the REAL local stack through docker compose and the public API.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, config, rawApi, sleep, waitFor } from '../lib/titan-client.mjs';

export { api, config, rawApi, sleep, waitFor };

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const DR_DIR = path.join(REPO, 'infrastructure', 'disaster-recovery');
export const BACKUP_DIR = path.join(DR_DIR, 'backups');
export const REPORT_DIR = path.join(DR_DIR, 'reports');

// Every profile is named so compose can resolve any service; commands that
// start things always pass an explicit service list.
const ALL_PROFILES = ['core', 'iot', 'analytics', 'ai', 'ai-model', 'observability', 'dr-lab'].flatMap((p) => ['--profile', p]);

export const INFRA = new Set(['postgres', 'postgres-dr', 'postgres-restore', 'dr-tools', 'nats', 'mosquitto', 'ollama', 'prometheus', 'grafana', 'loki', 'promtail']);

export function sh(command, args, options = {}) {
  return execFileSync(command, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}

/** Runs `docker compose ...`; `env` adds to the environment (e.g. DB_HOST for a failover). */
export function compose(args, env = {}) {
  return sh('docker', ['compose', ...ALL_PROFILES, ...args], { env: { ...process.env, ...env } });
}

export function tryCompose(args, env = {}) {
  try {
    return { ok: true, output: compose(args, env) };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message };
  }
}

export function runningServices() {
  return compose(['ps', '--services', '--status', 'running']).split(/\r?\n/).filter(Boolean);
}

/** Application services (everything that is not infrastructure), as currently running. */
export function runningApplicationServices() {
  return runningServices().filter((s) => !INFRA.has(s));
}

/** Runs SQL as the superuser from the dr-tools container; returns unaligned rows ("a|b"). */
export function psql(host, database, sql) {
  return compose(['exec', '-T', 'dr-tools', 'psql', '-h', host, '-d', database, '-v', 'ON_ERROR_STOP=1', '-X', '-At', '-c', sql]);
}

export function tryPsql(host, database, sql) {
  try {
    return { ok: true, output: psql(host, database, sql) };
  } catch (err) {
    return { ok: false, output: `${err.stderr ?? err.message}`.trim() };
  }
}

export function tools(args) {
  return compose(['exec', '-T', 'dr-tools', ...args]);
}

export function containerHealth(service) {
  try {
    const id = compose(['ps', '-q', service]);
    if (!id) return 'absent';
    return sh('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id.split(/\r?\n/)[0]]);
  } catch {
    return 'absent';
  }
}

export async function waitHealthy(services, timeoutMs = 180_000) {
  await waitFor(() => services.every((s) => ['healthy', 'running'].includes(containerHealth(s))), {
    timeoutMs,
    intervalMs: 2_000,
    what: `${services.join(', ')} to be healthy`,
  });
}

/** Waits until the gateway reports every listed application service ready. */
export async function waitServicesReady(services, timeoutMs = 240_000) {
  const wanted = services.filter((s) => s.endsWith('-service'));
  await waitFor(
    async () => {
      const health = await api('adam.admin', 'GET', '/api/platform/health');
      const status = new Map(health.services.map((s) => [s.service, s.status]));
      return wanted.every((s) => ['ok', 'degraded'].includes(status.get(s)));
    },
    { timeoutMs, intervalMs: 2_000, what: 'application services to report ready' },
  );
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const iso = (d = new Date()) => d.toISOString();
export const seconds = (ms) => Math.round(ms / 100) / 10;

// --- drill report ------------------------------------------------------------------

export class Report {
  constructor(type, objectives) {
    this.data = {
      drill_id: `${type}-${stamp()}`,
      type,
      started_at: iso(),
      finished_at: null,
      result: 'failed',
      environment: {
        topology: 'single-host laboratory (docker compose); primary and recovery databases are containers on one machine',
        disclaimer: 'Demonstrates the recovery procedure. NOT geographic disaster recovery and NOT evidence of production recovery times.',
        data: 'synthetic',
      },
      objectives,
      observed: { rto_seconds: null, rpo_seconds: null, data_loss_transactions: null },
      summary: null,
      steps: [],
      evidence: {},
      limitations: [],
    };
  }

  /** Runs one named step, recording when it started, how long it took and what it found. */
  async step(name, fn) {
    const started = Date.now();
    const entry = { name, started_at: iso(new Date(started)), duration_ms: 0, status: 'passed', detail: null };
    this.data.steps.push(entry);
    process.stdout.write(`  - ${name} ... `);
    try {
      const detail = await fn();
      entry.detail = detail ?? null;
      entry.duration_ms = Date.now() - started;
      console.log(`ok (${seconds(entry.duration_ms)} s)${typeof detail === 'string' ? `: ${detail}` : ''}`);
      return detail;
    } catch (err) {
      entry.status = 'failed';
      entry.detail = err.message;
      entry.duration_ms = Date.now() - started;
      console.log(`FAILED: ${err.message}`);
      throw err;
    }
  }

  check(condition, message) {
    if (!condition) throw new Error(message);
  }

  finish(result, summary) {
    this.data.result = result;
    this.data.summary = summary;
    this.data.finished_at = iso();
    mkdirSync(REPORT_DIR, { recursive: true });
    const base = path.join(REPORT_DIR, this.data.drill_id);
    writeFileSync(`${base}.json`, `${JSON.stringify(this.data, null, 2)}\n`);
    writeFileSync(`${base}.md`, this.markdown());
    console.log(`\nResult: ${result.toUpperCase()} - ${summary}`);
    console.log(`Report: ${path.relative(REPO, base)}.md (and .json)`);
    return this.data;
  }

  markdown() {
    const d = this.data;
    const fmt = (v, unit = ' s') => (v === null || v === undefined ? 'not measured' : `${v}${unit}`);
    const lines = [
      `# Recovery drill report: ${d.drill_id}`,
      '',
      `| | |`,
      `| --- | --- |`,
      `| Type | ${d.type} |`,
      `| Result | **${d.result.toUpperCase()}** |`,
      `| Started | ${d.started_at} |`,
      `| Finished | ${d.finished_at} |`,
      `| Topology | ${d.environment.topology} |`,
      `| Data | ${d.environment.data} |`,
      '',
      `> ${d.environment.disclaimer}`,
      '',
      '## Summary',
      '',
      d.summary ?? '',
      '',
      '## Objectives and observed values',
      '',
      '| Measure | Target (engineering objective) | Observed in this drill |',
      '| --- | --- | --- |',
      `| RTO | ${fmt(d.objectives?.rto_seconds)} | ${fmt(d.observed.rto_seconds)} |`,
      `| RPO | ${fmt(d.objectives?.rpo_seconds)} | ${fmt(d.observed.rpo_seconds)} |`,
      `| Transactions lost | 0 beyond RPO | ${fmt(d.observed.data_loss_transactions, '')} |`,
      '',
      '## Steps',
      '',
      '| # | Step | Status | Duration | Detail |',
      '| --- | --- | --- | --- | --- |',
      ...d.steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.status} | ${seconds(s.duration_ms)} s | ${String(typeof s.detail === 'string' ? s.detail : s.detail ? JSON.stringify(s.detail) : '').replace(/\|/g, '\\|').slice(0, 400)} |`),
      '',
      '## Evidence',
      '',
      '```json',
      JSON.stringify(d.evidence, null, 2),
      '```',
      '',
      '## Limitations of this drill',
      '',
      ...d.limitations.map((l) => `- ${l}`),
      '',
    ];
    return lines.join('\n');
  }
}

export function parseFlags(argv, known) {
  const flags = Object.fromEntries(known.map((k) => [k, false]));
  for (const arg of argv) {
    const key = arg.replace(/^--/, '');
    if (!(key in flags)) throw new Error(`unknown option ${arg} (known: ${known.map((k) => `--${k}`).join(', ')})`);
    flags[key] = true;
  }
  return flags;
}

/** Explicit operator confirmation: a flag for scripted drills, otherwise a typed phrase. */
export async function confirm(phrase, flag, question) {
  if (flag) {
    console.log(`  operator confirmation supplied on the command line (${phrase})`);
    return true;
  }
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${question}\nType ${phrase} to proceed, anything else to abort: `);
  rl.close();
  return answer.trim() === phrase;
}

// --- representative business transactions ----------------------------------------

const EVENT = (n) => ({ event_name: `DR drill event ${n}`, venue: 'Riverbend Square', event_date: '2027-10-01', expected_attendance: 100 });

export async function submitCase(tag, n) {
  const draft = await api('alice.applicant', 'POST', '/api/case/cases', { form_key: 'event-permit', title: `DR drill ${tag} #${n}`, data: EVENT(n) });
  await api('alice.applicant', 'POST', `/api/case/cases/${draft.id}/submit`);
  return { id: draft.id, reference_no: draft.reference_no, created_at: iso() };
}

async function decideStage(reviewer, caseId, stage) {
  const task = await waitFor(
    async () => (await api(reviewer, 'GET', `/api/workflow/tasks?subject_id=${caseId}`)).find((t) => t.stage_key === stage),
    { timeoutMs: 30_000, intervalMs: 300, what: `${stage} task for ${reviewer}` },
  );
  await api(reviewer, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve', comment: 'DR drill' });
}

/** Takes an event-permit case through its whole approval process (three decisions). */
export async function approveCase(caseId) {
  await decideStage('victor.validator', caseId, 'validation');
  await decideStage('tara.technical', caseId, 'joint_review');
  await decideStage('henry.head', caseId, 'joint_review');
  await waitFor(async () => (await api('alice.applicant', 'GET', `/api/case/cases/${caseId}`)).status === 'approved', { timeoutMs: 30_000, intervalMs: 300, what: 'case to be approved' });
}

export async function caseState(caseId) {
  const c = await rawApi('alice.applicant', 'GET', `/api/case/cases/${caseId}`);
  return c.status === 200 ? c.body.status : `http_${c.status}`;
}
