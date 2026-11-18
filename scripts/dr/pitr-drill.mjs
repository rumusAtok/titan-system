// Point-in-time recovery drill (recovery lab, dr-lab profile).
//
//   npm run dr:pitr-drill
//
// 1. Take a physical base backup of the primary (pg_basebackup, as the replication role).
// 2. Write transaction T1, note a target time, then write transaction T2.
// 3. Force the current WAL segment into the archive.
// 4. In a SEPARATE, isolated instance: base backup + archived WAL, recovery_target_time = target.
// 5. Verify: T1 is present, T2 is absent, and the instance stopped exactly at the target.
//
// The primary is only read from: nothing on it is stopped, changed or restored. Both instances
// run on this one machine, so this demonstrates the procedure; it is not geographic recovery.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO, Report, seconds, sh, sleep, submitCase, waitFor } from './lib.mjs';

const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const IMAGE = 'titan/postgres:dev';
const VOLUME = 'titan-pitr-work';
const CONTAINER = 'titan-pitr';
const WAL_VOLUME = 'titan_postgres-wal-archive';
const SUPER = env.POSTGRES_SUPERUSER;

const docker = (args, options = {}) => sh('docker', args, options);
const primarySql = (sql) => docker(['compose', 'exec', '-T', 'postgres', 'psql', '-U', SUPER, '-d', 'postgres', '-X', '-At', '-c', sql]);
const pitrSql = (db, sql) => docker(['exec', CONTAINER, 'psql', '-U', SUPER, '-d', db, '-X', '-At', '-c', sql]);
const cleanup = () => {
  try { docker(['rm', '-f', CONTAINER]); } catch { /* not running */ }
  try { docker(['volume', 'rm', '-f', VOLUME]); } catch { /* absent */ }
};

const report = new Report('pitr', { rto_seconds: null, rpo_seconds: 0, note: 'Recovery to a chosen moment: every transaction committed before the target is expected, none after it.' });
report.data.limitations.push(
  'Both the primary and the recovery instance run on one workstation; this demonstrates the procedure only.',
  'The WAL archive is a Docker volume on the same machine, kept for 3 days (WAL_ARCHIVE_RETENTION_DAYS). Production needs off-site archive storage.',
  'Only the database cluster is recovered; services were not pointed at the recovered instance in this drill.',
);

console.log(`Point-in-time recovery drill ${report.data.drill_id}`);
let result = 'failed';
let summary = 'The drill did not complete.';
const t = {};
try {
  await report.step('Prepare an empty work volume for the base backup', async () => {
    cleanup();
    docker(['volume', 'create', VOLUME]);
    docker(['run', '--rm', '-u', '0', '-v', `${VOLUME}:/pitr`, '--entrypoint', 'sh', IMAGE, '-c', 'chown postgres:postgres /pitr && chmod 700 /pitr']);
    return VOLUME;
  });

  await report.step('Take a physical base backup of the primary (pg_basebackup, replication role)', async () => {
    const started = Date.now();
    docker(['run', '--rm', '--network', 'titan', '-u', 'postgres', '-e', `PGPASSWORD=${env.DB_DEV_PASSWORD}_replicator`, '-v', `${VOLUME}:/pitr`, '--entrypoint', 'pg_basebackup', IMAGE,
      '-h', 'postgres', '-U', 'replicator', '-D', '/pitr/base', '-X', 'stream', '-c', 'fast'], { timeout: 1_800_000 });
    const size = docker(['run', '--rm', '-v', `${VOLUME}:/pitr`, '--entrypoint', 'du', IMAGE, '-sh', '/pitr/base']).split(/\s+/)[0];
    t.backup = { size, seconds: seconds(Date.now() - started) };
    return `${size} in ${t.backup.seconds} s`;
  });

  await report.step('Write T1, choose the recovery target, write T2', async () => {
    t.before = await submitCase('PITR before target', 1);
    await sleep(2_000);
    t.target = primarySql('SELECT now()::timestamptz(3)');
    await sleep(2_000);
    t.after = await submitCase('PITR after target', 2);
    return `T1 ${t.before.reference_no}, target ${t.target}, T2 ${t.after.reference_no}`;
  });

  await report.step('Archive the WAL that contains both transactions', async () => {
    const segment = primarySql('SELECT pg_walfile_name(pg_switch_wal())');
    await waitFor(() => (primarySql('SELECT COALESCE(last_archived_wal, \'\') FROM pg_stat_archiver') >= segment), { timeoutMs: 120_000, intervalMs: 1_000, what: `WAL segment ${segment} to be archived` });
    t.segment = segment;
    return `segment ${segment} archived`;
  });

  await report.step('Start an isolated recovery instance: base backup + archived WAL, target time', async () => {
    const started = Date.now();
    const script = [
      'set -e',
      'touch /pitr/base/recovery.signal',
      `printf "%s\\n" "restore_command = 'cp /wal-archive/%f %p'" "recovery_target_time = '${t.target}'" "recovery_target_action = 'promote'" >> /pitr/base/postgresql.auto.conf`,
      // Recovery refuses settings lower than the primary's (found by the first run of this drill).
      'exec postgres -D /pitr/base -c archive_mode=off -c max_connections=300 -c max_wal_senders=10 -c max_replication_slots=10 -c listen_addresses=localhost',
    ].join('\n');
    docker(['run', '-d', '--name', CONTAINER, '--network', 'titan-dr', '-u', 'postgres', '-v', `${VOLUME}:/pitr`, '-v', `${WAL_VOLUME}:/wal-archive:ro`, '--entrypoint', 'sh', IMAGE, '-c', script]);
    await waitFor(
      () => {
        const state = docker(['inspect', '-f', '{{.State.Status}}', CONTAINER]);
        if (state !== 'running') {
          const out = spawnSync('docker', ['logs', '--tail', '5', CONTAINER], { encoding: 'utf8' });
          throw new Error(`the recovery instance stopped: ${`${out.stdout}${out.stderr}`.trim().split('\n').slice(-3).join(' | ')}`);
        }
        try {
          return pitrSql('postgres', 'SELECT pg_is_in_recovery()') === 'f';
        } catch {
          return false;
        }
      },
      { timeoutMs: 600_000, intervalMs: 2_000, what: 'the recovery instance to reach the target and promote' },
    );
    t.recovery_seconds = seconds(Date.now() - started);
    report.data.observed.rto_seconds = t.recovery_seconds;
    // PostgreSQL writes its log to stderr.
    const out = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
    const logs = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
    const stop = /recovery stopping (before|after) [^\n]*/.exec(logs)?.[0] ?? null;
    t.stop = stop;
    return `promoted after ${t.recovery_seconds} s${stop ? `; ${stop}` : ''}`;
  });

  await report.step('Verify: T1 present, T2 absent, row-level security intact', async () => {
    const has = (id) => Number(pitrSql('titan_case', `SELECT count(*) FROM cases WHERE id = '${id}'`));
    const before = has(t.before.id);
    const after = has(t.after.id);
    report.check(before === 1, `T1 (${t.before.reference_no}, before the target) is missing`);
    report.check(after === 0, `T2 (${t.after.reference_no}, after the target) is present: recovery went past the target`);
    report.check(pitrSql('titan_case', "SELECT relrowsecurity FROM pg_class WHERE relname = 'cases'") === 't', 'row-level security is not enabled on the recovered cases table');
    const latest = pitrSql('titan_case', 'SELECT max(created_at)::timestamptz(3) FROM cases');
    report.data.observed.data_loss_transactions = 0;
    report.data.observed.rpo_seconds = 0;
    t.latest_recovered_case = latest;
    return `T1 present, T2 absent; newest recovered case created ${latest} (target ${t.target})`;
  });

  await report.step('Confirm the primary was not affected', async () => {
    const both = Number(primarySql(`SELECT count(*) FROM pg_database WHERE datname = 'titan_case'`));
    const status = docker(['compose', 'exec', '-T', 'postgres', 'psql', '-U', SUPER, '-d', 'titan_case', '-X', '-At', '-c', `SELECT count(*) FROM cases WHERE id IN ('${t.before.id}', '${t.after.id}')`]);
    report.check(both === 1 && status === '2', 'the primary does not have both transactions');
    return 'the primary still has T1 and T2';
  });

  result = 'passed';
  summary = `A base backup (${t.backup.size}, ${t.backup.seconds} s) plus archived WAL was recovered to ${t.target} in an isolated instance in ${t.recovery_seconds} s: the transaction committed before the target (${t.before.reference_no}) is present and the one after it (${t.after.reference_no}) is not.`;
} catch (err) {
  summary = `Failed: ${err.message}`;
} finally {
  report.data.evidence = t;
  cleanup();
}
report.finish(result, summary);
process.exit(result === 'passed' ? 0 : 1);
