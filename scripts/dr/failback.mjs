// Controlled failback: return from the recovery database to the original
// primary, then rebuild the recovery database as a standby again.
//
//   node scripts/dr/failback.mjs [--confirm-failback]
//
// Unlike a failover this is PLANNED: writes are stopped first, so nothing is lost.
// The data directories of both database containers are rebuilt during the
// procedure (the old primary's contents are obsolete after a failover).
//
// Steps
//   1. check that the recovery database is the acting primary
//   2. stop application services (planned outage begins)
//   3. rebuild the original primary as a standby of the recovery database
//   4. wait until it has replayed everything, then promote it
//   5. rebuild the recovery database as a standby of the original primary
//   6. start services against the original primary and validate
import {
  api, approveCase, caseState, compose, confirm, containerHealth, iso, parseFlags, psql, Report, runningApplicationServices, seconds, sh, submitCase,
  tryCompose, tryPsql, waitFor, waitHealthy, waitServicesReady,
} from './lib.mjs';

const PRIMARY = 'postgres';
const RECOVERY = 'postgres-dr';
const flags = parseFlags(process.argv.slice(2), ['confirm-failback']);
const report = new Report('failback', { rto_seconds: null, rpo_seconds: 0, note: 'Planned operation: no data loss is acceptable; the outage is a maintenance window.' });
const e = report.data.evidence;
const tag = report.data.drill_id.slice(-8);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'titan';

function removeNodeAndData(service, volume) {
  tryCompose(['rm', '-sf', service]);
  // The data directory is obsolete: remove it so the node is cloned afresh.
  sh('docker', ['volume', 'rm', '-f', `${project}_${volume}`]);
}

try {
  console.log(`Failback ${report.data.drill_id}`);
  let services = [];

  await report.step('Check preconditions: recovery database is the acting primary', async () => {
    report.check(tryPsql(RECOVERY, 'postgres', 'SELECT 1').ok, 'the recovery database is not reachable');
    report.check(psql(RECOVERY, 'postgres', 'SELECT pg_is_in_recovery()') === 'f', 'the recovery database is a standby: there is nothing to fail back from');
    report.check(containerHealth(PRIMARY) !== 'healthy', 'the original primary is running; refusing to continue (two primaries would be a split brain)');
    services = runningApplicationServices();
    report.check(services.length > 0, 'no application services are running');
    return `${services.length} application services are running on the recovery database`;
  });

  await report.step('Record a transaction on the recovery site (must survive the failback)', async () => {
    const c = await submitCase(tag, 1);
    await approveCase(c.id);
    e.transaction_before_failback = c;
    return `approved ${c.reference_no}`;
  });

  const go = await confirm('FAILBACK', flags['confirm-failback'], 'Failback stops all application services for a few minutes and rebuilds both database nodes.');
  e.operator_confirmation = { given: go, at: iso() };
  if (!go) {
    report.finish('aborted', 'Operator did not confirm the failback. Nothing was changed.');
    process.exit(2);
  }

  const outageStarted = Date.now();
  await report.step('Stop application services (planned outage begins)', async () => {
    compose(['stop', ...services]);
    return `${services.length} services stopped`;
  });

  await report.step('Record the final write position of the recovery database', async () => {
    psql(RECOVERY, 'postgres', 'CHECKPOINT');
    const lsn = psql(RECOVERY, 'postgres', 'SELECT pg_current_wal_lsn()');
    e.final_lsn_on_recovery = lsn;
    return lsn;
  });

  await report.step('Rebuild the original primary as a standby of the recovery database', async () => {
    removeNodeAndData(PRIMARY, 'postgres-data');
    compose(['up', '-d', '--no-deps', PRIMARY], { PG_PRIMARY_ROLE: 'standby', PG_PRIMARY_UPSTREAM: RECOVERY });
    await waitHealthy([PRIMARY], 300_000);
    report.check(psql(PRIMARY, 'postgres', 'SELECT pg_is_in_recovery()') === 't', 'the rebuilt node did not start as a standby');
    return 'cloned with pg_basebackup and streaming';
  });

  await report.step('Wait until the original primary has replayed every change', async () => {
    await waitFor(() => psql(PRIMARY, 'postgres', `SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '${e.final_lsn_on_recovery}') >= 0`) === 't', { timeoutMs: 120_000, intervalMs: 1_000, what: 'replay to reach the recorded position' });
    const replayed = psql(PRIMARY, 'postgres', 'SELECT pg_last_wal_replay_lsn()');
    e.replayed_lsn_on_original_primary = replayed;
    return `replayed ${replayed} (needed ${e.final_lsn_on_recovery})`;
  });

  await report.step('Promote the original primary and retire the recovery database from the primary role', async () => {
    // Stop the acting primary first: at no point do two nodes accept writes.
    compose(['stop', RECOVERY]);
    report.check(psql(PRIMARY, 'postgres', 'SELECT pg_promote(true, 60)') === 't', 'promotion did not complete');
    report.check(psql(PRIMARY, 'postgres', 'SELECT pg_is_in_recovery()') === 'f', 'the original primary is still in recovery');
    // Recreate the container with its normal (primary) configuration; the data directory is kept.
    compose(['up', '-d', '--no-deps', PRIMARY]);
    await waitHealthy([PRIMARY], 120_000);
    report.check(psql(PRIMARY, 'postgres', 'SELECT pg_is_in_recovery()') === 'f', 'the original primary lost the primary role after restart');
    return 'original primary promoted; recovery database stopped';
  });

  await report.step('Rebuild the recovery database as a standby of the original primary', async () => {
    removeNodeAndData(RECOVERY, 'postgres-dr-data');
    compose(['up', '-d', '--no-deps', RECOVERY]);
    await waitHealthy([RECOVERY], 300_000);
    await waitFor(() => psql(PRIMARY, 'postgres', "SELECT state FROM pg_stat_replication WHERE application_name = 'recovery-site'") === 'streaming', { timeoutMs: 120_000, intervalMs: 1_000, what: 'streaming replication to the recovery site' });
    return 'recovery database is a streaming standby again';
  });

  await report.step('Start application services against the original primary', async () => {
    compose(['up', '-d', '--no-deps', ...services]);
    await waitHealthy(services.filter((s) => s !== 'sensor-simulator'), 300_000);
    await waitServicesReady(services, 300_000);
    return `${services.length} services ready`;
  });
  const outageEnded = Date.now();

  await report.step('Validate: nothing was lost and the platform works', async () => {
    report.check((await caseState(e.transaction_before_failback.id)) === 'approved', 'the transaction recorded before the failback is missing');
    const fresh = await submitCase(tag, 2);
    await approveCase(fresh.id);
    const health = await api('adam.admin', 'GET', '/api/platform/health');
    const notOk = health.services.filter((s) => services.includes(s.service) && s.status !== 'ok').map((s) => s.service);
    report.check(notOk.length === 0, `services not healthy after failback: ${notOk.join(', ')}`);
    e.post_failback_transaction = fresh;
    return `pre-failback transaction present; new application ${fresh.reference_no} approved end to end`;
  });

  report.data.observed.rto_seconds = seconds(outageEnded - outageStarted);
  report.data.observed.rpo_seconds = 0;
  report.data.observed.data_loss_transactions = 0;
  e.timing = { outage_started_at: iso(new Date(outageStarted)), services_ready_at: iso(new Date(outageEnded)), explanation: 'Planned outage: from stopping the services to all services ready on the original primary.' };
  report.data.limitations.push(
    'Both nodes were re-cloned with pg_basebackup, which is practical only for small databases; production would use pg_rewind or a planned switchover of a healthy replica.',
    'Single host: no cross-site transfer time is included.',
  );
  report.finish('passed', `Controlled failback completed with a planned outage of ${report.data.observed.rto_seconds} s and no data loss. Original primary is primary again; the recovery database is a streaming standby.`);
} catch (err) {
  report.data.limitations.push('The failback did not complete; see the failed step and the failover and failback runbook for manual recovery.');
  report.finish('failed', err.message);
  process.exitCode = 1;
}
