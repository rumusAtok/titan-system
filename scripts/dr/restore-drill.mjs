// Test F - Backup and recovery drill.
//
//   node scripts/dr/restore-drill.mjs
//
// 1. creates representative transactions through the public API and records them;
// 2. takes a backup;
// 3. creates one more transaction AFTER the backup (it must be absent after the
//    restore: that is the data-loss window a backup-only recovery has);
// 4. restores the backup into an ISOLATED, empty PostgreSQL instance;
// 5. verifies checksums, row counts and the recorded transactions in the restore;
// 6. starts a real case-service against the restored database and performs
//    application operations (read an approved case, create a new one);
// 7. records the observed restore time and data-loss window in a report.
//
// The primary database is never modified by the restore.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEY_TABLES, takeBackup } from './backup.mjs';
import { api, approveCase, BACKUP_DIR, caseState, compose, config, iso, psql, Report, seconds, sh, sleep, submitCase, tools, tryCompose, waitFor, waitHealthy } from './lib.mjs';
import { tokenFor } from '../lib/titan-client.mjs';

const RESTORE_HOST = 'postgres-restore';
const CHECK_CONTAINER = 'titan-restore-check';
const CHECK_PORT = 18090;

const report = new Report('backup-restore', { rto_seconds: 4 * 3600, rpo_seconds: 24 * 3600, note: 'Targets for recovery from backup alone (no standby): restore within 4 h; loss bounded by the backup interval.' });
const e = report.data.evidence;
const tag = report.data.drill_id.slice(-8);

function cleanupCheckContainer() {
  try {
    sh('docker', ['rm', '-f', CHECK_CONTAINER]);
  } catch {
    // not running
  }
}

try {
  console.log(`Backup and restore drill ${report.data.drill_id}`);

  await report.step('Start recovery tooling', async () => {
    compose(['up', '-d', '--no-deps', 'dr-tools']);
    await waitFor(() => psql('postgres', 'postgres', 'SELECT 1') === '1', { timeoutMs: 60_000, what: 'dr-tools to reach the primary' });
  });

  await report.step('Create representative transactions (before the backup)', async () => {
    const approved = await submitCase(tag, 1);
    await approveCase(approved.id);
    const inReview = await submitCase(tag, 2);
    await waitFor(async () => (await caseState(inReview.id)) === 'in_review', { timeoutMs: 30_000, what: 'second case to reach review' });
    const asset = await api('amy.assets', 'POST', '/api/asset/assets', { code: `DRR-${tag}`, name: `Restore drill asset ${tag}`, category_code: 'DRAINAGE', status: 'active' });
    e.transactions_before_backup = { approved_case: approved, in_review_case: inReview, asset: { id: asset.id, code: asset.code } };
    return `2 cases (1 approved, 1 in review), 1 asset`;
  });

  // Let asynchronous effects of those transactions (notifications, audit) settle so they are in the backup.
  await sleep(3_000);

  let manifest;
  await report.step('Back up all databases', async () => {
    const m = await takeBackup({ host: 'postgres' });
    manifest = m;
    e.backup = { backup_id: m.backup_id, databases: m.databases.length, total_bytes: m.total_bytes, duration_seconds: m.duration_seconds, wal_lsn_at_start: m.wal_lsn_at_start, completed_at: m.completed_at };
    return `${m.backup_id}: ${m.databases.length} databases, ${(m.total_bytes / 1024 / 1024).toFixed(1)} MB in ${m.duration_seconds} s`;
  });

  let afterBackup;
  await report.step('Create one transaction AFTER the backup (expected to be lost)', async () => {
    const lost = await submitCase(tag, 3);
    afterBackup = lost;
    e.transaction_after_backup = lost;
    return `case ${lost.reference_no}`;
  });

  const disasterAt = new Date();
  e.simulated_disaster_at = iso(disasterAt);
  console.log(`  (simulated loss of the primary declared at ${e.simulated_disaster_at}; the primary itself is left untouched)`);

  await report.step('Start an isolated, empty recovery instance', async () => {
    tryCompose(['rm', '-sfv', RESTORE_HOST]);
    compose(['up', '-d', '--no-deps', RESTORE_HOST]);
    await waitHealthy([RESTORE_HOST], 120_000);
    // Empty: the init scripts created roles and databases, but no tables and no data.
    const tables = Number(psql(RESTORE_HOST, 'titan_case', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"));
    report.check(tables === 0, `the restore target is not empty (${tables} tables)`);
    return 'roles and empty databases present, no tables';
  });

  await report.step('Verify backup file checksums', async () => {
    for (const d of manifest.databases) {
      const [sha] = tools(['sha256sum', `/backups/${manifest.backup_id}/${d.file}`]).split(/\s+/);
      report.check(sha === d.sha256, `checksum mismatch for ${d.file}`);
    }
    return `${manifest.databases.length} archives match their SHA-256`;
  });

  const restoreStarted = Date.now();
  await report.step('Restore every database from the backup', async () => {
    for (const d of manifest.databases) {
      tools(['pg_restore', '-h', RESTORE_HOST, '-d', d.name, '--no-password', '--exit-on-error', '--jobs=2', `/backups/${manifest.backup_id}/${d.file}`]);
    }
    return `${manifest.databases.length} databases restored`;
  });

  await report.step('Verify restored row counts', async () => {
    const mismatches = [];
    const restored = {};
    for (const [database, tablesOf] of Object.entries(KEY_TABLES)) {
      for (const table of tablesOf) {
        const key = `${database}.${table}`;
        const count = Number(psql(RESTORE_HOST, database, `SELECT count(*) FROM ${table}`));
        restored[key] = count;
        const low = manifest.row_counts.before[key];
        const high = manifest.row_counts.after[key];
        if (count < low || count > high) mismatches.push(`${key}: restored ${count}, expected ${low}..${high}`);
      }
    }
    e.restored_row_counts = restored;
    report.check(mismatches.length === 0, `row counts outside the backup's bounds: ${mismatches.join('; ')}`);
    return `${Object.keys(restored).length} tables within the bounds recorded at backup time`;
  });

  await report.step('Verify recorded transactions in the restored databases', async () => {
    const t = e.transactions_before_backup;
    const status = (id) => psql(RESTORE_HOST, 'titan_case', `SELECT status FROM cases WHERE id = '${id}'`);
    report.check(status(t.approved_case.id) === 'approved', 'the approved case is not approved in the restore');
    report.check(status(t.in_review_case.id) === 'in_review', 'the in-review case has the wrong status in the restore');
    const decisions = Number(psql(RESTORE_HOST, 'titan_workflow', `SELECT count(*) FROM workflow_decisions d JOIN workflow_instances i ON i.id = d.instance_id WHERE i.subject_id = '${t.approved_case.id}'`));
    report.check(decisions === 3, `expected 3 decisions for the approved case, found ${decisions}`);
    const pending = Number(psql(RESTORE_HOST, 'titan_workflow', `SELECT count(*) FROM workflow_tasks t JOIN workflow_instances i ON i.id = t.instance_id WHERE i.subject_id = '${t.in_review_case.id}' AND t.status = 'pending'`));
    report.check(pending === 1, `expected 1 pending task for the in-review case, found ${pending}`);
    report.check(psql(RESTORE_HOST, 'titan_asset', `SELECT code FROM assets WHERE id = '${t.asset.id}'`) === t.asset.code, 'the asset is missing from the restore');
    const audited = Number(psql(RESTORE_HOST, 'titan_audit', `SELECT count(*) FROM audit_events WHERE aggregate_id = '${t.approved_case.id}'`));
    report.check(audited >= 2, 'audit records of the approved case are missing from the restore');
    const users = Number(psql(RESTORE_HOST, 'keycloak', "SELECT count(*) FROM user_entity WHERE username = 'alice.applicant'"));
    report.check(users === 1, 'the identity store was not restored');
    // Security controls must come back with the data, not only the rows.
    const rls = psql(RESTORE_HOST, 'titan_case', "SELECT relrowsecurity FROM pg_class WHERE relname = 'cases'");
    report.check(rls === 't', 'row-level security is not enabled on the restored cases table');
    return 'cases, decisions, pending task, asset, audit records, identity store and RLS present';
  });

  await report.step('Detect lost transactions', async () => {
    const present = psql(RESTORE_HOST, 'titan_case', `SELECT count(*) FROM cases WHERE id = '${afterBackup.id}'`);
    report.check(present === '0', 'a transaction created after the backup unexpectedly exists in the restore');
    e.lost_transactions = [afterBackup.reference_no];
    return `1 transaction created after the backup is absent, as expected (${afterBackup.reference_no})`;
  });

  await report.step('Run application operations against the restored database', async () => {
    cleanupCheckContainer();
    const pw = config.env.DB_DEV_PASSWORD;
    sh('docker', [
      'run', '-d', '--name', CHECK_CONTAINER, '--network', 'titan', '-p', `127.0.0.1:${CHECK_PORT}:3000`,
      '-e', 'SERVICE_NAME=case-service', '-e', 'DB_APP_ROLE=case_app',
      '-e', `DATABASE_URL=postgres://case_app:${pw}_case_app@${RESTORE_HOST}:5432/titan_case`,
      '-e', `DATABASE_OWNER_URL=postgres://case_owner:${pw}_case_owner@${RESTORE_HOST}:5432/titan_case`,
      // Deliberately unreachable broker: this instance must not consume or publish
      // events of the live platform. Its outbox simply buffers.
      '-e', 'NATS_URL=nats://127.0.0.1:4',
      '-e', `OIDC_ISSUER=${config.keycloakUrl}/realms/titan`,
      '-e', 'OIDC_JWKS_URI=http://keycloak:8080/realms/titan/protocol/openid-connect/certs',
      'titan/case-service:dev',
    ]);
    sh('docker', ['network', 'connect', 'titan-dr', CHECK_CONTAINER]);
    const base = `http://localhost:${CHECK_PORT}`;
    await waitFor(async () => (await fetch(`${base}/health/ready`)).status === 200, { timeoutMs: 120_000, intervalMs: 1_500, what: 'case-service on the restored database' });
    const headers = { authorization: `Bearer ${await tokenFor('alice.applicant')}`, 'content-type': 'application/json' };
    const t = e.transactions_before_backup;

    const read = await fetch(`${base}/cases/${t.approved_case.id}`, { headers });
    report.check(read.status === 200, `reading the approved case returned ${read.status}`);
    report.check((await read.json()).status === 'approved', 'the application reports a wrong status for the approved case');
    const lost = await fetch(`${base}/cases/${afterBackup.id}`, { headers });
    report.check(lost.status === 404, 'the case created after the backup is visible through the application');
    const written = await fetch(`${base}/cases`, { method: 'POST', headers, body: JSON.stringify({ form_key: 'event-permit', title: `Created on the restored database ${tag}`, data: {} }) });
    report.check(written.status === 201, `creating a case on the restored database returned ${written.status}`);
    const created = await written.json();
    // Reference numbers continue from the restored counter: no collision with restored data.
    report.check(created.reference_no > t.in_review_case.reference_no, 'reference numbering did not continue after the restore');
    // The migration runner accepted the restored schema history unchanged.
    const other = await fetch(`${base}/cases`, { headers: { authorization: `Bearer ${await tokenFor('bob.applicant')}` } });
    report.check((await other.json()).every((c) => c.id !== created.id), 'tenant isolation does not hold on the restored database');
    e.application_check = { read_restored_case: 'ok', post_backup_case: 'absent (404)', new_case_created: created.reference_no, tenant_isolation: 'ok' };
    return `read restored case, created ${created.reference_no}, tenant isolation holds`;
  });
  const restoredAt = Date.now();

  await report.step('Confirm the primary was not affected', async () => {
    report.check((await caseState(afterBackup.id)) !== 'http_404', 'the primary lost a transaction during the drill');
    return 'the live platform still has every transaction';
  });

  report.data.observed.rto_seconds = seconds(restoredAt - restoreStarted);
  // Each database is dumped from its own snapshot taken some time after the backup
  // STARTED, so the guaranteed recovery point is the start of the backup, not its end.
  report.data.observed.rpo_seconds = seconds(disasterAt.getTime() - new Date(manifest.created_at).getTime());
  report.data.observed.data_loss_transactions = 1;
  e.timing = {
    restore_started_at: iso(new Date(restoreStarted)),
    application_verified_at: iso(new Date(restoredAt)),
    explanation: 'Observed RTO = from the start of the restore to a verified application on the restored database. Observed RPO = time between the START of the backup and the simulated disaster: the worst-case window of writes lost when recovering from this backup alone. In operation this window is the backup interval.',
  };
  report.data.limitations.push(
    'Single host, small synthetic dataset: restore time grows with data volume and is not representative of production.',
    'The restore target is a container with disposable storage on the same machine as the primary.',
    'Logical backup only. Point-in-time recovery from the WAL archive is configured (archive_mode=on) but was not exercised by this drill.',
    'Only case-service was started against the restored data; the other services were verified at database level.',
    'Object storage, event stream contents and the analytical lake are not part of this backup (see the DR architecture document).',
  );

  // Record the successful verification on the backup itself.
  const manifestPath = path.join(BACKUP_DIR, manifest.backup_id, 'manifest.json');
  const stored = JSON.parse(readFileSync(manifestPath, 'utf8'));
  stored.verified = { at: iso(), result: 'passed', drill_id: report.data.drill_id };
  writeFileSync(manifestPath, `${JSON.stringify(stored, null, 2)}\n`);

  report.finish('passed', `Backup ${manifest.backup_id} restored into an isolated instance and verified in ${report.data.observed.rto_seconds} s. Recovery point is the start of the backup, ${report.data.observed.rpo_seconds} s before the simulated disaster; the 1 transaction written after the backup was lost, as expected for backup-only recovery.`);
} catch (err) {
  report.data.limitations.push('The drill did not complete; see the failed step.');
  report.finish('failed', err.message);
  process.exitCode = 1;
} finally {
  cleanupCheckContainer();
  tryCompose(['rm', '-sfv', RESTORE_HOST]);
}
